// Builds a small, self-contained ASAR fixture that mimics the real archive's
// layout (pickle prefix, 4-byte aligned header JSON, per-file integrity blocks)
// and contains byte-identical copies of the five patched host methods.
// Used by the offline tests; it never touches the real installation.
import fs from 'node:fs';
import path from 'node:path';
import { PATCHES, hash, align4, blockHashes } from '../snapshot-patch.mjs';

function method(idSuffix) {
  const spec = PATCHES.find(p => p.id.endsWith(idSuffix));
  if (!spec) throw Error('Unknown patch id suffix: ' + idSuffix);
  return spec.original;
}

export function hostFixtureText() {
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

// Writes a valid ASAR and returns the geometry the patch needs.
export function buildFixture(dir, options = {}) {
  const blockSize = options.blockSize ?? 1024;
  const files = options.files ?? [
    { path: 'out/host/index.js', buffer: Buffer.from(hostFixtureText(), 'utf8') },
    { path: 'out/other/data.txt', buffer: Buffer.from('fixture-payload\n'.repeat(220), 'utf8') },
    { path: 'out/other/empty.txt', buffer: Buffer.alloc(0) },
    { path: 'package.json', buffer: Buffer.from(JSON.stringify({ name: 'fixture', version: '0.0.0' }), 'utf8') },
  ];
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
    // Force a JSON length that is not a multiple of 4, mirroring the real
    // archive (which has two bytes of pickle padding).
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
  const host = placed.find(p => p.path === 'out/host/index.js');
  return {
    asarPath,
    files: placed,
    dataStart,
    jsonLen,
    headerSize,
    packageBytes: Buffer.concat([prefix, region, data]),
    host: {
      text: host.buffer.toString('utf8'),
      buffer: host.buffer,
      offset: String(host.entry.offset),
      size: host.buffer.length,
      sha256: hash(host.buffer),
    },
    otherEntry: placed.find(p => p.path === 'out/other/data.txt'),
  };
}
