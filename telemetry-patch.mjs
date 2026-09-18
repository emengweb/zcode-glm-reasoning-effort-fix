// ZCode telemetry / extra-report privacy patch.
//
// Scope of this module: it rewrites a small, fixed set of byte ranges inside
// four ASAR entries of the main process bundle so that ZCode's own extra
// uploads never start, while ordinary model requests and user-initiated
// network tools stay untouched:
//
//   out/main/index.js              ARMS RUM telemetry disabled + renderer-action
//                                  OTLP trace exporter disabled
//   out/main/chunk-6XM33EZR.js     ARMS RUM endpoint blanked
//   out/main/chunk-HW54O52P.js     ZCode event report transport short-circuited
//                                  (session/usage event sync to zcode.z.ai)
//   out/main/chunk-DBVOEQ2Z.js     packaged agent OTLP endpoint + headers blanked
//                                  (model trajectory traces to Aliyun ARMS)
//
// It is deliberately strict: every target entry must match a pinned version
// signature (known original SHA256, entry offset/size and header geometry), and
// every replacement must keep the entry's UTF-8 byte length unchanged so the
// ASAR header geometry and every other entry stay byte-identical. Unknown files
// are rejected instead of being rewritten.
//
// Standalone. Reuses the strict ASAR/backup/receipt primitives from
// snapshot-patch.mjs. No third-party dependency. Node >= 18.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hash,
  countOccurrences,
  readFully,
  writeFully,
  hashRegion,
  hashWithReplacements,
  readAsarHeader,
  getEntry,
  readEntryBuffer,
  blockHashes,
  verifyIntegrityBlocks,
  expectedBlocks,
  inspectExecutable,
  defaultAsar,
} from './snapshot-patch.mjs';

export { defaultAsar };
// Re-export the reused strict ASAR primitives so tests and consumers have a
// single entry point for both patches' shared machinery.
export {
  hash,
  countOccurrences,
  hashRegion,
  hashWithReplacements,
  readAsarHeader,
  getEntry,
  readEntryBuffer,
  blockHashes,
  verifyIntegrityBlocks,
  expectedBlocks,
  inspectExecutable,
};
export const PATCH_MARKER = 'telemetry-privacy:disabled';

const NOTE = PATCH_MARKER;

// ---------------------------------------------------------------------------
// Pinned version signature for ZCode 3.12.3 (Electron 41.0.3).
// patchedSha256 is the deterministic result of applying the specs below.
// ---------------------------------------------------------------------------
export const KNOWN_VERSION = {
  appVersion: '3.12.3',
  electron: '41.0.3',
  headerInts: [4, 7013000, 7012996, 7012990],
  dataStart: 7013008,
  jsonLen: 7012990,
  entries: {
    'out/main/index.js': {
      offset: '248945766',
      size: 708140,
      originalSha256: '5105c8659924d8c262bc763302131d6dc1f50b1249d9fc578e2d84cf76f55ae4',
      patchedSha256: '496f01cad77b688a14878cb58802cf6dbccb0e21a331fd3f2a25cfe8733ef51a',
    },
    'out/main/chunk-6XM33EZR.js': {
      offset: '246639402',
      size: 565982,
      originalSha256: '71142091b7d289cbec5243157082c24cb42cb62f5f35203a6ab336e14b0e47f8',
      patchedSha256: 'f3526ea30a4f2ef2da0a0ef7dfcd0d188a1ccec146c83632d289cf2c26a9ef09',
    },
    'out/main/chunk-HW54O52P.js': {
      offset: '247232047',
      size: 1540045,
      originalSha256: 'cc3c2b267bf86d7fd2d8be3f33a08acb37397ee2245b1ba88a9fbd53b343bda6',
      patchedSha256: '25904d7a3e6231c21b9610350e0d08c9c7ca27833b6de774294b39a24b4810ca',
    },
    'out/main/chunk-DBVOEQ2Z.js': {
      offset: '247208693',
      size: 675,
      originalSha256: '4ecc6034b1aaf431018ba5019d1c2e9bc352504e221d523b36d142a3a17c04c2',
      patchedSha256: '5c306da56513e9be9acee60e2c1ec663d921ae786723a4f3a12feb65c23dbd28',
    },
  },
};

// Exact original byte ranges (minified, byte-for-byte) replaced by this patch.
// `patched` must be the same UTF-8 byte length as `original`.
const RAW_SPECS = [
  {
    entry: 'out/main/index.js',
    id: 'main.armsRum.enable',
    original: 'mi.init({enable:!0,version:j,endpoint:Ta,',
    patched: 'mi.init({enable:!1,version:j,endpoint:Ta,',
  },
  {
    entry: 'out/main/index.js',
    id: 'main.rendererActionTrace.exporterDisabled',
    original: 'function Ww(e){let t=nD(e);if(t)return new rD(',
    patched: 'function Ww(e){let t=nD(e);if(0)return new rD(',
  },
  {
    entry: 'out/main/chunk-6XM33EZR.js',
    id: 'main.armsRum.endpoint',
    original: '"https://proj-xtrace-7e235817c9b9381c22d8b743908d469f-cn-beijing.cn-beijing.log.aliyuncs.com/rum/web/v2?workspace=default-cms-1936221977589032-cn-beijing&service_id=j2c03hoppk@7023210754a92ac5d1971"',
    blank: true,
  },
  {
    entry: 'out/main/chunk-HW54O52P.js',
    id: 'main.telemetryEventReport.sendReportAttempt',
    prefix: 'async function ie(T,V){',
    body: 'return',
    // Original captured byte-for-byte from the real bundle; validated on load.
    original:
      'async function ie(T,V){let J=new AbortController,N=setTimeout(()=>J.abort(),g),ue;try{ue=await n(T,{method:"POST",headers:{"Content-Type":"application/json"},body:V,signal:J.signal})}catch{throw new fn(J.signal.aborted?"timeout":"network",!0)}finally{clearTimeout(N)}if(!ue.ok)throw E(ue.status)}',
  },
  {
    entry: 'out/main/chunk-DBVOEQ2Z.js',
    id: 'main.agentTelemetry.otlpEndpoint',
    original:
      '"https://proj-xtrace-7e235817c9b9381c22d8b743908d469f-cn-beijing.cn-beijing.log.aliyuncs.com/apm/trace/opentelemetry"',
    blank: true,
  },
  {
    entry: 'out/main/chunk-DBVOEQ2Z.js',
    id: 'main.agentTelemetry.otlpHeaders',
    original:
      '"x-arms-license-key=j2c03hoppk@8309eb6928a66ff,x-arms-project=proj-xtrace-7e235817c9b9381c22d8b743908d469f-cn-beijing,x-cms-workspace=default-cms-1936221977589032-cn-beijing"',
    blank: true,
  },
];

// Turns a JSON string literal into a same-length whitespace literal so any
// consumer that trims/validates it sees an empty value instead of a URL.
export function blankJsonString(original) {
  if (original.length < 2 || original[0] !== '"' || original[original.length - 1] !== '"') {
    throw Error('blankJsonString expects a quoted JSON string');
  }
  return '"' + ' '.repeat(original.length - 2) + '"';
}

// Builds a marker-carrying replacement of exactly the original byte length.
export function buildMethodReplacement(spec) {
  const overhead = Buffer.byteLength(spec.prefix) + Buffer.byteLength(NOTE) + 5 + Buffer.byteLength(spec.body);
  const pad = Buffer.byteLength(spec.original) - overhead;
  if (pad < 0) throw Error('Patch note does not fit in ' + spec.id);
  return spec.prefix + '/*' + NOTE + ' '.repeat(pad) + '*/' + spec.body + '}';
}

export const PATCHES = RAW_SPECS.map(spec => {
  const patched = spec.blank ? blankJsonString(spec.original) : spec.prefix ? buildMethodReplacement(spec) : spec.patched;
  return { ...spec, patched };
});

// Re-derives the replacement from the original at runtime (so a corrupted spec
// cannot silently pass) and checks it is length-preserving.
function replacementFor(spec) {
  const patched = spec.blank ? blankJsonString(spec.original) : spec.prefix ? buildMethodReplacement(spec) : spec.patched;
  if (Buffer.byteLength(patched) !== Buffer.byteLength(spec.original)) {
    throw Error('Internal patch length mismatch for ' + spec.id);
  }
  return patched;
}

export function patchedAnchor(spec) {
  return spec.prefix ? spec.prefix + '/*' + NOTE : null;
}

// Applies every spec to the given entry texts. Idempotent per entry: a spec
// that already carries its marker (or, for blanked literals, already has no
// URL) is reported as already patched. Any ambiguous signature aborts the
// whole transformation.
export function transformEntries(textByEntry) {
  const applied = [];
  const already = [];
  const texts = {};
  for (const entry of Object.keys(textByEntry)) texts[entry] = textByEntry[entry];
  for (const spec of PATCHES) {
    const text = texts[spec.entry];
    if (typeof text !== 'string') throw Error('Missing entry text for ' + spec.entry);
    const patched = replacementFor(spec);
    const originalCount = countOccurrences(text, spec.original);
    if (originalCount === 1) {
      texts[spec.entry] = text.split(spec.original).join(patched);
      applied.push(spec.id);
      continue;
    }
    const alreadyPatched = originalCount === 0 && isAlreadyPatched(text, spec);
    if (alreadyPatched) {
      already.push(spec.id);
      continue;
    }
    throw Error(
      'Unknown signature for ' + spec.id + ' in ' + spec.entry + ' (original matches: ' + originalCount + '); refusing modification'
    );
  }
  for (const entry of Object.keys(textByEntry)) {
    if (Buffer.byteLength(texts[entry]) !== Buffer.byteLength(textByEntry[entry])) {
      throw Error('Replacement changed UTF-8 byte length of ' + entry + '; refusing modification');
    }
  }
  return { texts, changed: applied.length > 0, applied, already, total: PATCHES.length };
}

function isBlanked(text, spec) {
  // The blanked literal keeps its exact length, so look for the same-length run
  // of spaces delimited by quotes at the original position.
  const blank = blankJsonString(spec.original);
  return countOccurrences(text, blank) === 1;
}

// Detects an already-patched spec without mistaking it for an unknown version.
function isAlreadyPatched(text, spec) {
  if (spec.prefix) return countOccurrences(text, patchedAnchor(spec)) === 1;
  if (spec.blank) return isBlanked(text, spec);
  return countOccurrences(text, spec.patched) === 1;
}

// ---------------------------------------------------------------------------
// Backup / receipt helpers
// ---------------------------------------------------------------------------

function slug(entry) {
  return entry.replace(/[^A-Za-z0-9]+/g, '_');
}

export function backupPaths(target) {
  const paths = {
    header: target + '.telemetry-privacy.header.bak',
    receipt: target + '.telemetry-privacy.receipt.json',
    entries: {},
  };
  for (const entry of Object.keys(KNOWN_VERSION.entries)) {
    paths.entries[entry] = target + '.telemetry-privacy.entry.' + slug(entry) + '.bak';
  }
  return paths;
}

export function parseReceipt(text) {
  let receipt;
  try {
    receipt = JSON.parse(text);
  } catch {
    throw Error('Backup receipt is not valid JSON; refusing to use it');
  }
  if (!receipt || typeof receipt !== 'object' || receipt.version !== 1) throw Error('Unsupported receipt version');
  if (receipt.tool !== 'telemetry-patch.mjs') throw Error('Receipt was not written by telemetry-patch.mjs');
  return receipt;
}

export function loadReceipt(target) {
  const paths = backupPaths(target);
  if (!fs.existsSync(paths.receipt)) return null;
  const receipt = parseReceipt(fs.readFileSync(paths.receipt, 'utf8'));
  if (!receipt.backup || !receipt.backup.entries) throw Error('Receipt is missing entry backup metadata');
  if (!fs.existsSync(paths.header)) throw Error('Backup file missing: ' + paths.header);
  if (hash(fs.readFileSync(paths.header)) !== receipt.backup.headerSha256) {
    throw Error('Backup integrity failure for header backup');
  }
  for (const entry of Object.keys(receipt.backup.entries)) {
    const file = paths.entries[entry];
    if (!file || !fs.existsSync(file)) throw Error('Backup file missing for ' + entry);
    if (hash(fs.readFileSync(file)) !== receipt.backup.entries[entry]) {
      throw Error('Backup integrity failure for ' + entry);
    }
  }
  return receipt;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function resolveExpectations(override) {
  const expected = { ...KNOWN_VERSION, ...(override || {}) };
  expected.entries = { ...KNOWN_VERSION.entries, ...((override && override.entries) || {}) };
  return expected;
}

function readTargetEntries(meta, expected, options) {
  const entries = {};
  const buffers = {};
  for (const entryPath of Object.keys(expected.entries)) {
    const entry = getEntry(meta.header, entryPath);
    const pinned = expected.entries[entryPath];
    const buffer = readEntryBuffer(meta.fd, meta, entry);
    entries[entryPath] = entry;
    buffers[entryPath] = buffer;
  }
  return { entries, buffers };
}

function signatureProblems(meta, entries, buffers, expected) {
  const problems = [];
  if (expected.dataStart !== meta.dataStart) problems.push('header data start ' + meta.dataStart + ' != ' + expected.dataStart);
  if (expected.jsonLen !== meta.jsonLen) problems.push('header JSON length ' + meta.jsonLen + ' != ' + expected.jsonLen);
  for (const [entryPath, entry] of Object.entries(entries)) {
    const pinned = expected.entries[entryPath];
    if (String(entry.offset) !== String(pinned.offset)) problems.push(entryPath + ' offset ' + entry.offset + ' != ' + pinned.offset);
    if (Number(entry.size) !== Number(pinned.size)) problems.push(entryPath + ' size ' + entry.size + ' != ' + pinned.size);
  }
  return problems;
}

// Read-only, fail-closed assessment of the Electron crash reporter.
//
// This build must start crashReporter with uploadToServer:false and a
// non-routable submitURL. If a future build switches to remote crash upload
// (uploadToServer:true or a routable submitURL), check/verify must fail closed
// instead of silently passing. No bytes are modified by this assessment.
export function crashReporterAssessment(mainIndexText) {
  if (typeof mainIndexText !== 'string') {
    return { ok: false, reason: 'main index text unavailable' };
  }
  const marker = '.start({companyName:';
  const calls = countOccurrences(mainIndexText, marker);
  if (calls !== 1) {
    return { ok: false, reason: 'expected exactly one crashReporter.start call, found ' + calls };
  }
  const at = mainIndexText.indexOf(marker);
  const end = mainIndexText.indexOf('})', at);
  const call = mainIndexText.slice(at, end < 0 ? mainIndexText.length : end + 2);
  const localOnly = call.includes('uploadToServer:!1');
  const remoteUpload = call.includes('uploadToServer:!0');
  const submitVar = /submitURL:([A-Za-z0-9_$]+)/.exec(call);
  let submitUrl = null;
  if (submitVar) {
    const m = new RegExp(submitVar[1] + '="([^"]*)"').exec(mainIndexText);
    submitUrl = m ? m[1] : null;
  }
  const nonRoutable = submitUrl === 'https://zcode.invalid/local-crash-only';
  const ok = localOnly && nonRoutable && !remoteUpload;
  return {
    ok,
    reason: ok
      ? 'crashReporter.start is local-only (uploadToServer:false, non-routable submitURL)'
      : 'crash reporter configuration is not provably local-only; refusing to pass',
    calls,
    localOnly,
    remoteUpload,
    submitUrl,
  };
}

function entryStatus(buffers, expected) {  const states = [];
  for (const [entryPath, buffer] of Object.entries(buffers)) {
    const pinned = expected.entries[entryPath];
    const sha = hash(buffer);
    if (sha === pinned.originalSha256) states.push({ entryPath, state: 'original' });
    else if (sha === pinned.patchedSha256) states.push({ entryPath, state: 'patched' });
    else states.push({ entryPath, state: 'unknown', sha });
  }
  const unknown = states.filter(s => s.state === 'unknown');
  const patched = states.filter(s => s.state === 'patched');
  if (unknown.length) return { status: 'unknown', states, unknown };
  if (patched.length === states.length) return { status: 'applied', states };
  if (patched.length === 0) return { status: 'patchable', states };
  return { status: 'partial', states, patched };
}

// ---------------------------------------------------------------------------
// check / verify / apply / rollback
// ---------------------------------------------------------------------------

export function checkState(target, options = {}) {
  const expected = resolveExpectations(options.expected);
  const meta = readAsarHeader(target);
  try {
    const { entries, buffers } = readTargetEntries(meta, expected, options);
    const problems = signatureProblems(meta, entries, buffers, expected);
    const state = entryStatus(buffers, expected);
    const integrity = {};
    for (const [entryPath, entry] of Object.entries(entries)) {
      integrity[entryPath] = verifyIntegrityBlocks(entry, buffers[entryPath]);
    }
    const headerHashes = {
      headerJson: hash(meta.jsonBuf),
      headerRegionFrom8: hashRegion(meta.fd, 8, meta.dataStart - 8),
    };
    const exePath = options.exePath ?? path.join(path.dirname(path.dirname(target)), 'ZCode.exe');
    const exe = options.inspectExe === false ? null : inspectExecutable(exePath, headerHashes);
    const receipt = fs.existsSync(backupPaths(target).receipt);
    const crash = crashReporterAssessment(buffers['out/main/index.js'].toString('utf8'));
    return { target, meta, entries, buffers, problems, ...state, integrity, headerHashes, exe, receipt, crash, expected };
  } finally {
    fs.closeSync(meta.fd);
  }
}

export function apply(target, options = {}) {
  const expected = resolveExpectations(options.expected);
  const paths = backupPaths(target);
  const meta = readAsarHeader(target);
  fs.closeSync(meta.fd);
  const fd = fs.openSync(target, 'r+');
  const closeFd = () => { try { fs.closeSync(fd); } catch { /* already closed */ } };
  // readAsarHeader opened the archive read-only; every read below must use the
  // new read-write descriptor, not the closed one (fd numbers can be reused).
  meta.fd = fd;
  meta.fileSize = fs.fstatSync(fd).size;
  try {
    const { entries, buffers } = readTargetEntries(meta, expected, options);
    const problems = signatureProblems(meta, entries, buffers, expected);
    if (problems.length) throw Error('Unknown ZCode signature: ' + problems.join('; ') + '. Refusing to modify.');
    const state = entryStatus(buffers, expected);
    if (state.status === 'applied') return { status: 'already-applied', target };
    if (state.status === 'unknown') {
      throw Error(
        'Unknown entry SHA256 for ' + state.unknown.map(u => u.entryPath + '=' + u.sha).join(', ') +
          '; known signatures are the pinned original and patched hashes. Refusing to modify.'
      );
    }
    if (state.status === 'partial') {
      throw Error('Inconsistent state: some target entries are patched and some are not. Refusing to modify.');
    }
    for (const [entryPath, entry] of Object.entries(entries)) {
      const check = verifyIntegrityBlocks(entry, buffers[entryPath]);
      if (!check.ok) throw Error('Entry integrity is inconsistent before patching (' + entryPath + '): ' + check.reason);
    }

    const headerHashes = {
      headerJson: hash(meta.jsonBuf),
      headerRegionFrom8: hashRegion(fd, 8, meta.dataStart - 8),
    };
    const exePath = options.exePath ?? path.join(path.dirname(path.dirname(target)), 'ZCode.exe');
    const exe = options.inspectExe === false ? null : inspectExecutable(exePath, headerHashes);
    if (exe && exe.assessment.risk === 'blocking' && !options.acceptEmbeddedIntegrityRisk) {
      throw Error('Embedded ASAR integrity validation is enabled and matches the current header. Changing the header would break startup. Refusing to modify.');
    }
    if (exe && exe.assessment.risk === 'uncertain' && !options.acceptEmbeddedIntegrityRisk) {
      throw Error('Embedded ASAR integrity is enabled but could not be proven inactive. Refusing to modify without --accept-embedded-integrity-risk.');
    }

    if (fs.existsSync(paths.header) || fs.existsSync(paths.receipt) ||
        Object.values(paths.entries).some(p => fs.existsSync(p))) {
      throw Error('Backup exists: inspect or rollback first');
    }

    const textByEntry = {};
    for (const [entryPath, buffer] of Object.entries(buffers)) textByEntry[entryPath] = buffer.toString('utf8');
    const transformed = transformEntries(textByEntry);
    if (!transformed.changed) throw Error('Nothing to patch: entries already carry the marker');

    const patchedBuffers = {};
    for (const [entryPath, text] of Object.entries(transformed.texts)) {
      const buf = Buffer.from(text, 'utf8');
      if (buf.length !== buffers[entryPath].length) throw Error('Patched length changed for ' + entryPath + '; refusing to write');
      const pinned = expected.entries[entryPath];
      if (hash(buf) !== pinned.patchedSha256) {
        throw Error('Patched SHA256 for ' + entryPath + ' does not match the pinned patched hash. Refusing to write.');
      }
      patchedBuffers[entryPath] = buf;
    }

    // Rewrite each target entry's integrity object in the header. Every
    // replacement keeps its JSON length, so jsonLen/dataStart stay identical.
    let newJsonText = meta.jsonText;
    const newIntegrityByEntry = {};
    for (const [entryPath, entry] of Object.entries(entries)) {
      const oldIntegrity = entry.integrity;
      const patchedSha = hash(patchedBuffers[entryPath]);
      const newBlocks = expectedBlocks(patchedBuffers[entryPath], Number(oldIntegrity.blockSize));
      const oldIntegrityJson = JSON.stringify(oldIntegrity);
      if (countOccurrences(newJsonText, oldIntegrityJson) !== 1) {
        throw Error('Integrity block for ' + entryPath + ' is not unique in the header; refusing to write');
      }
      const newIntegrity = { ...oldIntegrity, hash: patchedSha, blocks: newBlocks };
      const newIntegrityJson = JSON.stringify(newIntegrity);
      if (newIntegrityJson.length !== oldIntegrityJson.length) {
        throw Error('New integrity metadata changed length for ' + entryPath + '; refusing to write');
      }
      newJsonText = newJsonText.replace(oldIntegrityJson, newIntegrityJson);
      newIntegrityByEntry[entryPath] = newIntegrity;
    }
    if (newJsonText.length !== meta.jsonText.length) throw Error('Header rewrite changed its length; refusing to write');
    const newJsonBuf = Buffer.from(newJsonText, 'utf8');
    let newHeader;
    try {
      newHeader = JSON.parse(newJsonText);
    } catch {
      throw Error('Rewritten header is not valid JSON; refusing to write');
    }
    for (const entryPath of Object.keys(entries)) {
      const newEntry = getEntry(newHeader, entryPath);
      if (newEntry.integrity.hash !== hash(patchedBuffers[entryPath])) {
        throw Error('Rewritten header integrity does not match ' + entryPath + '; refusing to write');
      }
    }

    const originalRegion = Buffer.alloc(meta.headerSize);
    readFully(fd, originalRegion, 0, meta.headerSize, 8);
    if (hash(originalRegion) !== headerHashes.headerRegionFrom8) throw Error('Target changed while reading the header');
    const newRegion = Buffer.concat([
      originalRegion.subarray(0, 8),
      newJsonBuf,
      originalRegion.subarray(8 + meta.jsonLen),
    ]);
    if (newRegion.length !== meta.headerSize) throw Error('Header region length changed; refusing to write');

    const replacements = [{ start: 8, buffer: newRegion }];
    for (const [entryPath, entry] of Object.entries(entries)) {
      replacements.push({ start: meta.dataStart + Number(entry.offset), buffer: patchedBuffers[entryPath] });
    }
    const beforeAsarSha = hashRegion(fd, 0, meta.fileSize);
    const expectedAfterSha = hashWithReplacements(fd, meta.fileSize, replacements);

    fs.writeFileSync(paths.header, originalRegion, { flag: 'wx' });
    const backupEntryShas = {};
    for (const [entryPath, buffer] of Object.entries(buffers)) {
      fs.writeFileSync(paths.entries[entryPath], buffer, { flag: 'wx' });
      backupEntryShas[entryPath] = hash(buffer);
    }
    const receipt = {
      version: 1,
      tool: 'telemetry-patch.mjs',
      createdAt: new Date().toISOString(),
      target,
      knownVersion: expected.appVersion,
      before: {
        asarSha256: beforeAsarSha,
        headerSha256: headerHashes.headerRegionFrom8,
        fileSize: meta.fileSize,
        dataStart: meta.dataStart,
        jsonLen: meta.jsonLen,
        headerSize: meta.headerSize,
        entries: {},
      },
      after: {
        asarSha256: expectedAfterSha,
        headerSha256: hash(newRegion),
        entries: {},
      },
      backup: { headerSha256: hash(fs.readFileSync(paths.header)), entries: backupEntryShas },
      patches: transformed.applied,
      embeddedIntegrity: exe ? { assessment: exe.assessment, fuseEnabled: exe.fuseEnabled, fuseStates: exe.fuse?.states ?? null } : null,
    };
    for (const [entryPath, entry] of Object.entries(entries)) {
      receipt.before.entries[entryPath] = {
        offset: String(entry.offset),
        size: Number(entry.size),
        sha256: hash(buffers[entryPath]),
        integrity: entry.integrity,
      };
      receipt.after.entries[entryPath] = {
        sha256: hash(patchedBuffers[entryPath]),
        integrity: newIntegrityByEntry[entryPath],
      };
    }
    fs.writeFileSync(paths.receipt, JSON.stringify(receipt, null, 2), { flag: 'wx' });

    const recheck = hashRegion(fd, 0, meta.fileSize);
    if (recheck !== beforeAsarSha) {
      fs.unlinkSync(paths.receipt);
      fs.unlinkSync(paths.header);
      for (const p of Object.values(paths.entries)) fs.unlinkSync(p);
      throw Error('Target changed concurrently; refusing write');
    }

    writeFully(fd, newRegion, 8);
    for (const [entryPath, entry] of Object.entries(entries)) {
      writeFully(fd, patchedBuffers[entryPath], meta.dataStart + Number(entry.offset));
    }
    fs.fsyncSync(fd);

    const afterAsarSha = hashRegion(fd, 0, meta.fileSize);
    const verifyFd = fs.openSync(target, 'r');
    try {
      const verifyHeader = Buffer.alloc(meta.headerSize);
      readFully(verifyFd, verifyHeader, 0, meta.headerSize, 8);
      if (hash(verifyHeader) !== receipt.after.headerSha256) throw Error('Post-write verification failed: header hash mismatch');
      for (const [entryPath, entry] of Object.entries(entries)) {
        const reread = Buffer.alloc(patchedBuffers[entryPath].length);
        readFully(verifyFd, reread, 0, reread.length, meta.dataStart + Number(entry.offset));
        if (hash(reread) !== hash(patchedBuffers[entryPath])) throw Error('Post-write verification failed for ' + entryPath);
      }
    } finally {
      fs.closeSync(verifyFd);
    }
    if (afterAsarSha !== expectedAfterSha) {
      throw Error('Post-write verification failed: archive hash ' + afterAsarSha + ' != expected ' + expectedAfterSha);
    }
    return { status: 'applied', target, backup: paths, patches: transformed.applied, asarSha256: afterAsarSha };
  } finally {
    closeFd();
  }
}

export function verify(target, options = {}) {
  const expected = resolveExpectations(options.expected);
  const meta = readAsarHeader(target);
  const problems = [];
  try {
    const { entries, buffers } = readTargetEntries(meta, expected, options);
    const state = entryStatus(buffers, expected);
    if (state.status !== 'applied') problems.push('target entries are not fully patched (status: ' + state.status + ')');
    for (const [entryPath, entry] of Object.entries(entries)) {
      const result = verifyIntegrityBlocks(entry, buffers[entryPath]);
      if (!result.ok) problems.push('entry integrity failure (' + entryPath + '): ' + result.reason);
    }
    const crash = crashReporterAssessment(buffers['out/main/index.js'].toString('utf8'));
    if (!crash.ok) problems.push('crash reporter check: ' + crash.reason);

    let checked = 0;
    let skippedUnpacked = 0;
    const ranges = [];
    const walk = node => {
      if (node.files) {
        for (const child of Object.values(node.files)) walk(child);
        return;
      }
      if (node.unpacked || node.offset === undefined) { skippedUnpacked++; return; }
      const buffer = readEntryBuffer(meta.fd, meta, node);
      const result = verifyIntegrityBlocks(node, buffer);
      if (!result.ok) problems.push('entry integrity failure: ' + result.reason);
      ranges.push([Number(node.offset), Number(node.offset) + Number(node.size)]);
      checked++;
    };
    walk(meta.header);
    ranges.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i][0] < ranges[i - 1][1]) problems.push('entry offset overlap detected');
    }
    const dataSize = meta.fileSize - meta.dataStart;
    if (ranges.length && ranges[ranges.length - 1][1] > dataSize) problems.push('entry extends past data area');

    const asarSha = hashRegion(meta.fd, 0, meta.fileSize);
    let receipt = null;
    try {
      receipt = loadReceipt(target);
    } catch (e) {
      problems.push(e.message);
    }
    if (receipt) {
      if (!receipt.after.asarSha256) {
        problems.push('backup receipt has no post-patch archive hash; cannot prove other entries are unchanged');
      } else if (receipt.after.asarSha256 !== asarSha) {
        problems.push('archive hash does not match the receipt (another patch may have been applied afterwards)');
      }
    } else if (state.status === 'applied') {
      problems.push('backup receipt is missing; cannot prove other entries are unchanged');
    }
    return {
      ok: problems.length === 0,
      status: state.status,
      asarSha,
      checked,
      skippedUnpacked,
      problems,
      crash,
      receipt: receipt
        ? { createdAt: receipt.createdAt, knownVersion: receipt.knownVersion, patches: receipt.patches, embeddedIntegrity: receipt.embeddedIntegrity }
        : null,
    };
  } finally {
    fs.closeSync(meta.fd);
  }
}

export function rollback(target, options = {}) {
  const paths = backupPaths(target);
  const receipt = parseReceipt(fs.readFileSync(paths.receipt, 'utf8'));
  if (receipt.target !== target) throw Error('Receipt belongs to a different target; refusing destructive rollback');
  const headerBackup = fs.readFileSync(paths.header);
  if (hash(headerBackup) !== receipt.backup.headerSha256) throw Error('Backup integrity failure for header backup');
  const entryBackups = {};
  for (const [entryPath, sha] of Object.entries(receipt.backup.entries)) {
    const file = paths.entries[entryPath];
    if (!file) throw Error('Unknown backup entry in receipt: ' + entryPath);
    entryBackups[entryPath] = fs.readFileSync(file);
    if (hash(entryBackups[entryPath]) !== sha) throw Error('Backup integrity failure for ' + entryPath);
    const before = receipt.before.entries[entryPath];
    if (!before || entryBackups[entryPath].length !== Number(before.size)) throw Error('Backup length mismatch for ' + entryPath);
  }
  if (headerBackup.length !== receipt.before.headerSize) throw Error('Backup header length mismatch');

  const dataStart = receipt.before.dataStart;
  const fd = fs.openSync(target, 'r+');
  try {
    const size = fs.fstatSync(fd).size;
    if (receipt.before.fileSize && size !== receipt.before.fileSize) {
      throw Error('Target size changed since patch; refusing destructive rollback');
    }
    const current = hashRegion(fd, 0, size);
    const cleanup = () => {
      fs.unlinkSync(paths.receipt);
      fs.unlinkSync(paths.header);
      for (const p of Object.values(paths.entries)) fs.unlinkSync(p);
    };
    if (current === receipt.before.asarSha256) {
      cleanup();
      return { status: 'already-restored', target };
    }
    if (!receipt.after.asarSha256 || current !== receipt.after.asarSha256) {
      const replacements = [{ start: 8, buffer: headerBackup }];
      for (const [entryPath, buffer] of Object.entries(entryBackups)) {
        replacements.push({ start: dataStart + Number(receipt.before.entries[entryPath].offset), buffer });
      }
      let outside;
      try {
        outside = hashWithReplacements(fd, size, replacements);
      } catch (e) {
        throw Error('Target cannot hold the backed-up regions; refusing destructive rollback (' + e.message + ')');
      }
      if (outside !== receipt.before.asarSha256) {
        throw Error('Target changed outside the patched regions since patch; refusing destructive rollback');
      }
    }
    writeFully(fd, headerBackup, 8);
    for (const [entryPath, buffer] of Object.entries(entryBackups)) {
      writeFully(fd, buffer, dataStart + Number(receipt.before.entries[entryPath].offset));
    }
    fs.fsyncSync(fd);
    const restored = hashRegion(fd, 0, size);
    if (restored !== receipt.before.asarSha256) throw Error('Rollback verification failed');
    cleanup();
    return { status: 'restored', target };
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function bilingual(zh, en) {
  return zh.join('\n') + '\n\n--- English ---\n' + en.join('\n');
}

function describeExe(exe, zh, en) {
  if (!exe) return;
  if (!exe.exists) { zh.push('未找到 ZCode.exe，跳过电子封装完整性检查。'); en.push('ZCode.exe not found; embedded integrity check skipped.'); return; }
  zh.push('电子封装检查：融合开关版本 ' + (exe.fuse ? exe.fuse.version : '未知') + '，共 ' + (exe.fuse ? exe.fuse.count : '未知') + ' 项。');
  en.push('Electron packaging check: fuse wire version ' + (exe.fuse ? exe.fuse.version : 'unknown') + ', ' + (exe.fuse ? exe.fuse.count : 'unknown') + ' entries.');
  if (exe.fuse) { zh.push('融合开关状态串：' + exe.fuse.states); en.push('Fuse state string: ' + exe.fuse.states); }
  zh.push('内嵌 ASAR 完整性阻断风险评估：' + exe.assessment.risk + '（' + exe.assessment.reason + '）。');
  en.push('Embedded ASAR integrity risk: ' + exe.assessment.risk + ' (' + exe.assessment.reason + ').');
}

function describeCrash(crash, zh, en) {
  if (!crash) return;
  zh.push('崩溃上报检查（只读、fail-closed）：' + (crash.ok ? '通过' : '未通过') + ' —— ' + crash.reason + '。');
  en.push('Crash-report check (read-only, fail-closed): ' + (crash.ok ? 'pass' : 'fail') + ' - ' + crash.reason + '.');
  if (crash.submitUrl) { zh.push('submitURL：' + crash.submitUrl); en.push('submitURL: ' + crash.submitUrl); }
}

function statusZh(status) {  return { patchable: '可打补丁', applied: '已打补丁', unknown: '未知签名', partial: '部分打补丁' }[status] || status;
}

function cli() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const confirm = argv.includes('--confirm');
  const acceptRisk = argv.includes('--accept-embedded-integrity-risk');
  const args = argv.slice(1);
  const asarFlag = args.indexOf('--asar');
  let target = asarFlag >= 0 ? args[asarFlag + 1] : undefined;
  if (!target) {
    const positional = args.filter((a, i) => !a.startsWith('--') && (asarFlag < 0 || i !== asarFlag + 1));
    target = positional[0];
  }
  target = target || defaultAsar;
  const options = { acceptEmbeddedIntegrityRisk: acceptRisk };
  const zh = [];
  const en = [];
  try {
    if (command === 'check' && !fs.existsSync(target)) {
      throw Error('找不到所需文件：' + target);
    }
    if (command === 'check') {
      const state = checkState(target, options);
      zh.push('目标：' + target);
      en.push('Target: ' + target);
      zh.push('状态：' + statusZh(state.status));
      en.push('Status: ' + state.status);
      for (const s of state.states) zh.push('- ' + s.entryPath + '：' + statusZh(s.state) + (s.sha ? '（' + s.sha + '）' : ''));
      for (const s of state.states) en.push('- ' + s.entryPath + ': ' + s.state + (s.sha ? ' (' + s.sha + ')' : ''));
      if (state.problems.length) { zh.push('问题：'); state.problems.forEach(p => zh.push('- ' + p)); en.push('Problems:'); state.problems.forEach(p => en.push('- ' + p)); }
      describeExe(state.exe, zh, en);
      describeCrash(state.crash, zh, en);
      process.exitCode = state.status === 'unknown' || state.problems.length || !state.crash.ok ? 1 : 0;
    } else if (command === 'apply') {
      if (!confirm) throw Error('apply requires --confirm');
      const result = apply(target, options);
      zh.push(result.status === 'already-applied' ? '已处于打补丁状态，无需重复应用。' : '补丁已应用，共 ' + result.patches.length + ' 项。');
      en.push(result.status === 'already-applied' ? 'Already applied; nothing to do.' : 'Applied ' + result.patches.length + ' patch(es).');
      if (result.asarSha256) { zh.push('补丁后归档 SHA256：' + result.asarSha256); en.push('Archive SHA256 after patch: ' + result.asarSha256); }
      zh.push('需要完全退出并重新启动 ZCode 后才会生效。');
      en.push('A full quit and restart of ZCode is required for this to take effect.');
    } else if (command === 'verify') {
      const result = verify(target, options);
      zh.push(result.ok ? '验证通过。' : '验证未通过：');
      en.push(result.ok ? 'Verification passed.' : 'Verification failed:');
      result.problems.forEach(p => { zh.push('- ' + p); en.push('- ' + p); });
      process.exitCode = result.ok ? 0 : 1;
    } else if (command === 'rollback') {
      if (!confirm) throw Error('rollback requires --confirm');
      const result = rollback(target, options);
      zh.push(result.status === 'restored' ? '已回滚到补丁前状态。' : '已处于补丁前状态，无需回滚。');
      en.push(result.status === 'restored' ? 'Rolled back to the pre-patch state.' : 'Already at the pre-patch state; nothing to do.');
    } else {
      zh.push('用法：node telemetry-patch.mjs <check|apply|verify|rollback> [app.asar] [--confirm] [--accept-embedded-integrity-risk]');
      en.push('Usage: node telemetry-patch.mjs <check|apply|verify|rollback> [app.asar] [--confirm] [--accept-embedded-integrity-risk]');
      process.exitCode = 1;
    }
  } catch (e) {
    zh.push('错误：' + e.message);
    en.push('Error: ' + e.message);
    process.exitCode = 1;
  }
  console.log(bilingual(zh, en));
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) cli();
