// Builds a small, self-contained ASAR fixture that mimics the real archive's
// layout and contains byte-identical copies of the telemetry patch anchors
// (plus, optionally, the five snapshot-patch host methods) so the interaction
// tests can exercise both patches on the same archive.
//
// It never touches the real installation.
import fs from 'node:fs';
import path from 'node:path';
import { PATCHES as TELEMETRY_PATCHES } from '../telemetry-patch.mjs';
import { PATCHES as SNAPSHOT_PATCHES, hash, align4, blockHashes } from '../snapshot-patch.mjs';

export function telemetryFixtureText(entryPath, options = {}) {
  const specs = TELEMETRY_PATCHES.filter(p => p.entry === entryPath);
  if (!specs.length) throw Error('No telemetry specs for ' + entryPath);
  const lines = [
    "'use strict';",
    '// Offline fixture standing in for ' + entryPath + '.',
    ...specs.map(s => s.original),
  ];
  if (entryPath === 'out/main/index.js') {
    // The real main index carries a local-only crash reporter; include one so
    // the read-only fail-closed crash check can be exercised both ways.
    lines.push(
      options.crash === 'remote'
        ? 'var dP="https://crash.zcode.z.ai/report";cP.start({companyName:"",submitURL:dP,uploadToServer:!0,compress:!0});'
        : 'var dP="https://zcode.invalid/local-crash-only";cP.start({companyName:"",submitURL:dP,uploadToServer:!1,compress:!0});'
    );
  }
  lines.push('module.exports = {};', '');
  return lines.join('\n');
}

export function hostFixtureText() {
  const method = suffix => {
    const spec = SNAPSHOT_PATCHES.find(p => p.id.endsWith(suffix));
    if (!spec) throw Error('Unknown snapshot spec: ' + suffix);
    return spec.original;
  };
  return [
    "'use strict';",
    '// Offline fixture standing in for out/host/index.js.',
    'class RepoSnapshotSidecar {',
    '  ' + method('captureBeforePrompt'),
    '}',
    'class RepoSnapshotUploadWorker {',
    '  ' + method('flushWorkspace'),
    '  ' + method('flushActiveUpload'),
    '}',
    'class RepoSnapshotUploadClient {',
    '  ' + method('getUploadCredential'),
    '  ' + method('uploadObject'),
    '}',
    'module.exports = { RepoSnapshotSidecar, RepoSnapshotUploadWorker, RepoSnapshotUploadClient };',
    '',
  ].join('\n');
}

function integrity(buffer, blockSize) {
  return { algorithm: 'SHA256', hash: hash(buffer), blockSize, blocks: blockHashes(buffer, blockSize) };
}

function insertEntry(tree, parts, entry) {
  let node = tree;
  for (let i = 0; i < parts.length - 1; i++) {
    node.files[parts[i]] ??= { files: {} };
    node = node.files[parts[i]];
  }
  node.files[parts[parts.length - 1]] = entry;
}

// Generic ASAR writer: places the given { path, buffer } files in order.
export function buildAsarFromFiles(dir, files, options = {}) {
  const blockSize = options.blockSize ?? 1024;
  const header = { files: {} };
  let cursor = 0;
  const placed = [];
  for (const file of files) {
    const entry = { size: file.buffer.length, offset: String(cursor), integrity: integrity(file.buffer, blockSize) };
    insertEntry(header, file.path.split('/'), entry);
    placed.push({ ...file, entry, absoluteOffset: cursor });
    cursor += file.buffer.length;
  }
  const jsonBuf = (() => {
    for (let k = 1; k <= 8; k++) {
      const candidate = { ...header, ['p'.repeat(k)]: 0 };
      const buf = Buffer.from(JSON.stringify(candidate), 'utf8');
      if (buf.length % 4 !== 0) return buf;
    }
    throw Error('Could not build unaligned fixture header');
  })();
  const jsonLen = jsonBuf.length;
  const pad = align4(jsonLen) - jsonLen;
  const payload = 4 + jsonLen + pad;
  const headerSize = 4 + payload;
  const dataStart = 8 + headerSize;
  const region = Buffer.alloc(headerSize);
  region.writeUInt32LE(payload, 0);
  region.writeUInt32LE(jsonLen, 4);
  jsonBuf.copy(region, 8);
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(headerSize, 4);
  const data = Buffer.concat(files.map(f => f.buffer));
  const asarPath = options.asarPath ?? path.join(dir, 'app.asar');
  fs.writeFileSync(asarPath, Buffer.concat([prefix, region, data]));
  const byPath = {};
  for (const p of placed) byPath[p.path] = p;
  return { asarPath, files: placed, byPath, dataStart, jsonLen, headerSize, packageBytes: Buffer.concat([prefix, region, data]) };
}

const TELEMETRY_ENTRIES = [
  'out/main/index.js',
  'out/main/chunk-6XM33EZR.js',
  'out/main/chunk-HW54O52P.js',
  'out/main/chunk-DBVOEQ2Z.js',
];

// Builds the telemetry fixture. `withHost` adds the snapshot-patch host entry
// so the two patches can be combined on one archive.
export function buildTelemetryFixture(dir, options = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const files = TELEMETRY_ENTRIES.map(p => ({ path: p, buffer: Buffer.from(telemetryFixtureText(p, options), 'utf8') }));
  if (options.withHost) files.push({ path: 'out/host/index.js', buffer: Buffer.from(hostFixtureText(), 'utf8') });
  files.push({ path: 'out/other/data.txt', buffer: Buffer.from('fixture-payload\n'.repeat(220), 'utf8') });
  files.push({ path: 'package.json', buffer: Buffer.from(JSON.stringify({ name: 'fixture', version: '0.0.0' }), 'utf8') });
  const built = buildAsarFromFiles(dir, files, options);
  return { ...built, entryPaths: TELEMETRY_ENTRIES };
}
