// ZCode Agent model-telemetry hard-block patch (resources/glm/zcode.cjs).
//
// The packaged main process already blanks the OTLP endpoint it hands to the
// host/Agent, but a local `.env` can re-inject OTEL_EXPORTER_OTLP_* and the
// Agent bundle would then initialise model-trajectory telemetry again. This
// module hard-blocks the Agent's single shared initialisation entry instead, so
// telemetry stays off even with a valid OTLP endpoint and
// ZCODE_MODEL_TELEMETRY_ENABLED=true.
//
// It rewrites exactly one function inside the plain (non-ASAR) file
// `resources/glm/zcode.cjs`:
//
//   async function H4n(e,t={}){...}   // "prepareModelTelemetryEnv"
//
// H4n is the only caller of a_s ("createPreparedOwner"), which is the only
// caller of createOwnedAgentTelemetryRuntime, which builds the OTLP runtime.
// Blocking H4n therefore disables every Agent telemetry exporter at one place.
//
// It is deliberately strict: the file must match a pinned size and SHA256, and
// the replacement must keep the UTF-8 byte length unchanged. Unknown files are
// rejected instead of being rewritten. A full-file backup and a signed receipt
// are written before the file is touched.
//
// Standalone. Reuses the strict hash/write primitives from snapshot-patch.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, countOccurrences, writeFully } from './snapshot-patch.mjs';

export { hash, countOccurrences };

export const defaultAgentFile = 'C:/Program Files/ZCode/resources/glm/zcode.cjs';
export const PATCH_MARKER = 'telemetry-privacy:disabled';

const NOTE = PATCH_MARKER;

// Pinned signature for ZCode 3.12.3 (Electron 41.0.3).
export const KNOWN_VERSION = {
  appVersion: '3.12.3',
  electron: '41.0.3',
  size: 11416833,
  originalSha256: 'da61b0663336a65f7cce3dec223678794ccaa58158e304fc0d97b695434a8f01',
  patchedSha256: '6cc4e410a933506888bb261558d48642d945d1932e883556a3324431c91361a1',
};

const SPEC = {
  id: 'agent.modelTelemetry.prepareEnv',
  prefix: 'async function H4n(e,t={}){',
  body: 'return e',
  // Exact original captured byte-for-byte from the real bundle; validated on load.
  original:
    'async function H4n(e,t={}){if(!a8t(e)||b_s(e.ZCODE_MODEL_TELEMETRY_ENABLED))return e;let n=c8t(e.ZCODE_TELEMETRY_DEVICE_MID)??await l_s(e.ZCODE_HOME?.trim()),o=n?{...e,ZCODE_TELEMETRY_DEVICE_MID:n}:e;return!Pfe&&!Ofe&&(Pfe=a_s(o,t)),Ofe=await Pfe,o}',
};

export function buildPatched(spec = SPEC) {
  const overhead = Buffer.byteLength(spec.prefix) + Buffer.byteLength(NOTE) + 5 + Buffer.byteLength(spec.body);
  const pad = Buffer.byteLength(spec.original) - overhead;
  if (pad < 0) throw Error('Patch note does not fit in ' + spec.id);
  return spec.prefix + '/*' + NOTE + ' '.repeat(pad) + '*/' + spec.body + '}';
}

export function patchedAnchor(spec = SPEC) {
  return spec.prefix + '/*' + NOTE;
}

export const PATCHES = [{ ...SPEC, patched: buildPatched(SPEC) }];

// Applies the spec to the agent bundle text. Idempotent: an already-marked
// entry is reported instead of being changed twice. Any ambiguous or unknown
// signature aborts the transformation.
export function transformAgent(text) {
  const spec = PATCHES[0];
  const patched = buildPatched(spec);
  if (Buffer.byteLength(patched) !== Buffer.byteLength(spec.original)) {
    throw Error('Internal patch length mismatch for ' + spec.id);
  }
  const originalCount = countOccurrences(text, spec.original);
  if (originalCount === 1) {
    const next = text.split(spec.original).join(patched);
    if (Buffer.byteLength(next) !== Buffer.byteLength(text)) {
      throw Error('Replacement changed UTF-8 byte length of the agent bundle; refusing modification');
    }
    return { text: next, changed: true, applied: [spec.id], already: [], total: PATCHES.length };
  }
  if (originalCount === 0 && countOccurrences(text, patchedAnchor(spec)) === 1) {
    return { text, changed: false, applied: [], already: [spec.id], total: PATCHES.length };
  }
  throw Error(
    'Unknown signature for ' + spec.id + ' (original matches: ' + originalCount + '); refusing modification'
  );
}

// ---------------------------------------------------------------------------
// Backup / receipt helpers
// ---------------------------------------------------------------------------

export function backupPaths(file) {
  return {
    file: file + '.telemetry-privacy.bak',
    receipt: file + '.telemetry-privacy.receipt.json',
  };
}

export function parseReceipt(text) {
  let receipt;
  try {
    receipt = JSON.parse(text);
  } catch {
    throw Error('Backup receipt is not valid JSON; refusing to use it');
  }
  if (!receipt || typeof receipt !== 'object' || receipt.version !== 1) throw Error('Unsupported receipt version');
  if (receipt.tool !== 'agent-telemetry-patch.mjs') throw Error('Receipt was not written by agent-telemetry-patch.mjs');
  return receipt;
}

export function loadReceipt(file) {
  const paths = backupPaths(file);
  if (!fs.existsSync(paths.receipt)) return null;
  const receipt = parseReceipt(fs.readFileSync(paths.receipt, 'utf8'));
  if (receipt.target !== file) throw Error('Receipt belongs to a different target');
  if (!fs.existsSync(paths.file)) throw Error('Backup file missing: ' + paths.file);
  const backup = fs.readFileSync(paths.file);
  if (hash(backup) !== receipt.backup.sha256) throw Error('Backup integrity failure for the agent bundle');
  if (backup.length !== receipt.before.size) throw Error('Backup length mismatch for the agent bundle');
  return receipt;
}

// ---------------------------------------------------------------------------
// check / verify / apply / rollback
// ---------------------------------------------------------------------------

function resolveExpectations(override) {
  return { ...KNOWN_VERSION, ...(override || {}) };
}

export function checkState(file = defaultAgentFile, options = {}) {
  const expected = resolveExpectations(options.expected);
  if (!fs.existsSync(file)) {
    return { file, exists: false, status: 'missing', problems: ['找不到所需文件：' + file] };
  }
  const buffer = fs.readFileSync(file);
  const sha = hash(buffer);
  const problems = [];
  if (buffer.length !== expected.size) problems.push('file size ' + buffer.length + ' != ' + expected.size);
  const status = sha === expected.originalSha256 ? 'patchable' : sha === expected.patchedSha256 ? 'applied' : 'unknown';
  if (status === 'unknown') problems.push('unknown SHA256 ' + sha);
  return { file, exists: true, size: buffer.length, sha, status, problems, expected, receipt: fs.existsSync(backupPaths(file).receipt) };
}

export function apply(file = defaultAgentFile, options = {}) {
  const expected = resolveExpectations(options.expected);
  const paths = backupPaths(file);
  const state = checkState(file, options);
  if (!state.exists) throw Error('找不到所需文件：' + file);
  if (state.status === 'applied') return { status: 'already-applied', file };
  if (state.status === 'unknown') {
    throw Error('Unknown agent bundle SHA256 ' + state.sha + '; known signatures are ' + expected.originalSha256 + ' (original) and ' + expected.patchedSha256 + ' (patched). Refusing to modify.');
  }
  if (fs.existsSync(paths.file) || fs.existsSync(paths.receipt)) throw Error('Backup exists: inspect or rollback first');

  const original = fs.readFileSync(file);
  const beforeSha = hash(original);
  const transformed = transformAgent(original.toString('utf8'));
  if (!transformed.changed) throw Error('Nothing to patch: agent bundle already carries the marker');
  const patched = Buffer.from(transformed.text, 'utf8');
  if (patched.length !== original.length) throw Error('Patched agent length changed; refusing to write');
  const patchedSha = hash(patched);
  if (patchedSha !== expected.patchedSha256) {
    throw Error('Patched agent SHA256 ' + patchedSha + ' != expected ' + expected.patchedSha256 + '. Refusing to write.');
  }
  // The exact byte range this patch changes; rollback only rewrites this range.
  const regionOffset = original.indexOf(Buffer.from(SPEC.original, 'utf8'));
  if (regionOffset < 0) throw Error('Patch region not found; refusing to write');
  const region = { offset: regionOffset, length: Buffer.byteLength(SPEC.original) };

  fs.writeFileSync(paths.file, original, { flag: 'wx' });
  const receipt = {
    version: 1,
    tool: 'agent-telemetry-patch.mjs',
    createdAt: new Date().toISOString(),
    target: file,
    knownVersion: expected.appVersion,
    before: { sha256: beforeSha, size: original.length },
    after: { sha256: patchedSha, size: patched.length },
    backup: { sha256: hash(fs.readFileSync(paths.file)) },
    region,
    patches: transformed.applied,
  };
  fs.writeFileSync(paths.receipt, JSON.stringify(receipt, null, 2), { flag: 'wx' });

  const recheck = hash(fs.readFileSync(file));
  if (recheck !== beforeSha) {
    fs.unlinkSync(paths.receipt);
    fs.unlinkSync(paths.file);
    throw Error('Target changed concurrently; refusing write');
  }

  const fd = fs.openSync(file, 'r+');
  try {
    writeFully(fd, patched, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const after = fs.readFileSync(file);
  if (hash(after) !== patchedSha || after.length !== original.length) {
    throw Error('Post-write verification failed for the agent bundle');
  }
  return { status: 'applied', file, backup: paths, patches: transformed.applied, sha256: patchedSha };
}

export function verify(file = defaultAgentFile, options = {}) {
  const expected = resolveExpectations(options.expected);
  const problems = [];
  if (!fs.existsSync(file)) {
    return { ok: false, status: 'missing', problems: ['找不到所需文件：' + file] };
  }
  const buffer = fs.readFileSync(file);
  const sha = hash(buffer);
  const status = sha === expected.originalSha256 ? 'patchable' : sha === expected.patchedSha256 ? 'applied' : 'unknown';
  if (status !== 'applied') problems.push('agent bundle is not patched (status: ' + status + ')');
  let receipt = null;
  try {
    receipt = loadReceipt(file);
  } catch (e) {
    problems.push(e.message);
  }
  if (receipt) {
    if (receipt.after.sha256 !== sha) problems.push('agent SHA256 does not match the receipt');
  } else if (status === 'applied') {
    problems.push('backup receipt is missing; cannot prove the original was preserved');
  }
  return { ok: problems.length === 0, status, sha, problems, receipt: receipt ? { createdAt: receipt.createdAt, patches: receipt.patches } : null };
}

export function rollback(file = defaultAgentFile) {
  const paths = backupPaths(file);
  if (!fs.existsSync(paths.receipt)) throw Error('Backup receipt is missing; refusing to rollback');
  const receipt = parseReceipt(fs.readFileSync(paths.receipt, 'utf8'));
  if (receipt.target !== file) throw Error('Receipt belongs to a different target; refusing destructive rollback');
  if (!fs.existsSync(paths.file)) throw Error('Backup file missing: ' + paths.file);
  const backup = fs.readFileSync(paths.file);
  if (hash(backup) !== receipt.backup.sha256) throw Error('Backup integrity failure for the agent bundle');
  if (backup.length !== receipt.before.size) throw Error('Backup length mismatch for the agent bundle');
  const region = receipt.region;
  if (!region || !Number.isSafeInteger(region.offset) || !Number.isSafeInteger(region.length)) {
    throw Error('Receipt has no patch region; refusing destructive rollback');
  }
  if (region.offset < 0 || region.offset + region.length > backup.length) {
    throw Error('Receipt patch region is out of range; refusing destructive rollback');
  }

  const current = fs.readFileSync(file);
  const currentSha = hash(current);
  const cleanup = () => {
    fs.unlinkSync(paths.receipt);
    fs.unlinkSync(paths.file);
  };
  if (currentSha === receipt.before.sha256) {
    cleanup();
    return { status: 'already-restored', file };
  }

  // Restore only the patched region. This is destructive, so accept only two
  // states: exactly what apply wrote, or a partial/torn write inside the
  // region. In the latter case, replacing just the region must reproduce the
  // pre-patch whole-file hash, which proves every byte outside it is intact.
  if (current.length !== receipt.before.size) {
    throw Error('Target size changed since patch; refusing destructive rollback');
  }
  if (currentSha !== receipt.after.sha256) {
    const candidate = Buffer.from(current);
    backup.copy(candidate, region.offset, region.offset, region.offset + region.length);
    if (hash(candidate) !== receipt.before.sha256) {
      throw Error('Target changed outside the patched region since patch; refusing destructive rollback');
    }
  }
  const backupRegion = backup.subarray(region.offset, region.offset + region.length);
  const fd = fs.openSync(file, 'r+');
  try {
    writeFully(fd, backupRegion, region.offset);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (hash(fs.readFileSync(file)) !== receipt.before.sha256) throw Error('Rollback verification failed');
  cleanup();
  return { status: 'restored', file };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function bilingual(zh, en) {
  return zh.join('\n') + '\n\n--- English ---\n' + en.join('\n');
}

function statusZh(status) {
  return { patchable: '可打补丁', applied: '已打补丁', unknown: '未知签名', missing: '文件缺失' }[status] || status;
}

function cli() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const confirm = argv.includes('--confirm');
  const positional = argv.slice(1).filter(a => !a.startsWith('--'));
  const file = positional[0] || defaultAgentFile;
  const zh = [];
  const en = [];
  try {
    if (command === 'check') {
      const state = checkState(file);
      zh.push('目标：' + file, '状态：' + statusZh(state.status));
      en.push('Target: ' + file, 'Status: ' + state.status);
      if (state.exists) { zh.push('大小：' + state.size + '，SHA256：' + state.sha); en.push('Size: ' + state.size + ', SHA256: ' + state.sha); }
      state.problems.forEach(p => { zh.push('- ' + p); en.push('- ' + p); });
      process.exitCode = state.status === 'patchable' ? 0 : 1;
    } else if (command === 'apply') {
      if (!confirm) throw Error('apply requires --confirm');
      const result = apply(file);
      zh.push(result.status === 'already-applied' ? '已处于打补丁状态，无需重复应用。' : 'Agent 遥测硬阻断补丁已应用。');
      en.push(result.status === 'already-applied' ? 'Already applied; nothing to do.' : 'Agent telemetry hard-block patch applied.');
      if (result.sha256) { zh.push('补丁后 SHA256：' + result.sha256); en.push('SHA256 after patch: ' + result.sha256); }
      zh.push('需要完全退出并重新启动 ZCode 后才会生效。');
      en.push('A full quit and restart of ZCode is required for this to take effect.');
    } else if (command === 'verify') {
      const result = verify(file);
      zh.push(result.ok ? '验证通过。' : '验证未通过：');
      en.push(result.ok ? 'Verification passed.' : 'Verification failed:');
      result.problems.forEach(p => { zh.push('- ' + p); en.push('- ' + p); });
      process.exitCode = result.ok ? 0 : 1;
    } else if (command === 'rollback') {
      if (!confirm) throw Error('rollback requires --confirm');
      const result = rollback(file);
      zh.push(result.status === 'restored' ? '已回滚到补丁前状态。' : '已处于补丁前状态，无需回滚。');
      en.push(result.status === 'restored' ? 'Rolled back to the pre-patch state.' : 'Already at the pre-patch state; nothing to do.');
    } else {
      zh.push('用法：node agent-telemetry-patch.mjs <check|apply|verify|rollback> [zcode.cjs] [--confirm]');
      en.push('Usage: node agent-telemetry-patch.mjs <check|apply|verify|rollback> [zcode.cjs] [--confirm]');
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
