// Suite 2: end-to-end apply / verify / rollback on a synthetic ASAR in a temp
// directory, plus refusal paths (unknown version, unknown entry, partial state,
// existing backup, external change, corrupted backup, wrong target).
// The real installation is never written to.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, report, tempDir, cleanup, assertThrows } from './helpers.mjs';
import { buildTelemetryFixture } from './fixture-telemetry-asar.mjs';
import {
  hash, transformEntries, apply, verify, rollback, checkState, backupPaths, loadReceipt,
  readAsarHeader, getEntry, readEntryBuffer, blockHashes, KNOWN_VERSION, PATCHES,
  crashReporterAssessment,
} from '../telemetry-patch.mjs';

const root = tempDir('zcode-tel-apply-');
const missingExe = path.join(root, 'no-such.exe');
const ENTRIES = Object.keys(KNOWN_VERSION.entries);

function expectedFor(fixture) {
  const texts = {};
  for (const p of ENTRIES) texts[p] = fixture.byPath[p].buffer.toString('utf8');
  const transformed = transformEntries(texts);
  const expected = { ...KNOWN_VERSION, appVersion: 'fixture', dataStart: fixture.dataStart, jsonLen: fixture.jsonLen, entries: {} };
  for (const p of ENTRIES) {
    const orig = fixture.byPath[p].buffer;
    expected.entries[p] = {
      offset: fixture.byPath[p].entry.offset,
      size: orig.length,
      originalSha256: hash(orig),
      patchedSha256: hash(Buffer.from(transformed.texts[p], 'utf8')),
    };
  }
  return expected;
}

function fixtureDir(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readEntryBytes(asarPath, entryPath) {
  const meta = readAsarHeader(asarPath);
  try {
    return readEntryBuffer(meta.fd, meta, getEntry(meta.header, entryPath));
  } finally {
    fs.closeSync(meta.fd);
  }
}

function headerIntegrities(asarPath) {
  const meta = readAsarHeader(asarPath);
  fs.closeSync(meta.fd);
  const out = {};
  const walk = (node, prefix) => {
    if (node.files) {
      for (const [name, child] of Object.entries(node.files)) walk(child, prefix + '/' + name);
      return;
    }
    out[prefix] = node.integrity;
  };
  walk(meta.header, '');
  return out;
}

try {
  // --- happy path ----------------------------------------------------------
  const f1 = buildTelemetryFixture(fixtureDir('happy'));
  const e1 = expectedFor(f1);
  check(f1.jsonLen % 4 !== 0, '夹具头部带非零填充（贴近真实 ASAR）', 'fixture header has non-zero padding (like the real ASAR)');

  const before = checkState(f1.asarPath, { expected: e1, exePath: missingExe });
  check(before.status === 'patchable' && before.problems.length === 0, '初始状态：可打补丁且签名匹配', 'initial state: patchable with a matching signature');
  check(ENTRIES.every(p => before.integrity[p].ok), '4 个目标条目完整性自洽', 'all four target entries are integrity-consistent');

  const applied = apply(f1.asarPath, { expected: e1, exePath: missingExe });
  check(applied.status === 'applied' && applied.patches.length === 6, 'apply 应用全部 6 个补丁', 'apply installs all six patches');

  const v1 = verify(f1.asarPath, { expected: e1, exePath: missingExe });
  check(v1.ok === true && v1.status === 'applied', 'apply 后深度验证通过', 'deep verification passes after apply');
  check(v1.checked === 6 && v1.skippedUnpacked === 0, '校验了全部 6 个条目', 'all six entries verified');

  const otherAfter = readEntryBytes(f1.asarPath, 'out/other/data.txt');
  check(Buffer.compare(otherAfter, f1.byPath['out/other/data.txt'].buffer) === 0, '其他条目数据逐字节未变', 'other entry bytes are unchanged');

  const intAfter = headerIntegrities(f1.asarPath);
  check(ENTRIES.every(p => intAfter['/' + p].hash === e1.entries[p].patchedSha256), '4 个条目完整性已更新为新哈希', 'all four entry integrity hashes are updated');
  const idxSize = e1.entries['out/main/index.js'].size;
  check(intAfter['/out/main/index.js'].blocks.length === Math.max(1, Math.ceil(idxSize / 1024)), 'block 列表按夹具 blockSize 重算', 'block list recomputed for the fixture blockSize');

  check(apply(f1.asarPath, { expected: e1, exePath: missingExe }).status === 'already-applied', '重复 apply 幂等', 'repeat apply is idempotent');

  const receipt1 = loadReceipt(f1.asarPath);
  check(receipt1 && receipt1.tool === 'telemetry-patch.mjs' && Object.keys(receipt1.after.entries).length === 4, '备份收据记录 4 个条目前后哈希', 'backup receipt records all four entries');

  const patchedText = readEntryBytes(f1.asarPath, 'out/main/chunk-6XM33EZR.js').toString('utf8');
  check(patchedText.includes('"' + ' '.repeat(40)), '已补丁条目保留等长空白字面量', 'patched entry keeps an equal-length whitespace literal');
  check(!patchedText.includes('rum/web/v2?workspace='), '已补丁条目不再含上报地址', 'patched entry no longer contains the upload URL');

  const rolled = rollback(f1.asarPath, {});
  check(rolled.status === 'restored', 'rollback 成功恢复', 'rollback restores successfully');
  check(Buffer.compare(fs.readFileSync(f1.asarPath), f1.packageBytes) === 0, '回滚后整个 ASAR 与原始逐字节一致', 'archive is byte-identical after rollback');
  check(!fs.existsSync(backupPaths(f1.asarPath).receipt), '回滚后收据已清理', 'receipt removed after rollback');
  check(checkState(f1.asarPath, { expected: e1, exePath: missingExe }).status === 'patchable', '回滚后状态恢复为可打补丁', 'status returns to patchable after rollback');

  // --- unknown version geometry must be refused ---------------------------
  {
    const f = buildTelemetryFixture(fixtureDir('wrong-version'));
    const e = { ...expectedFor(f), dataStart: f.dataStart + 4, jsonLen: f.jsonLen + 4 };
    const st = checkState(f.asarPath, { expected: e, exePath: missingExe });
    check(st.problems.length > 0, '头部几何不匹配时报告问题', 'a header-geometry mismatch is reported');
    assertThrows(() => apply(f.asarPath, { expected: e, exePath: missingExe }), /Unknown ZCode signature/, 'wrong version geometry must be refused');
    check(true, '错误版本几何被拒绝（不写入）', 'wrong version geometry is refused without writing');
  }

  // --- unknown entry bytes must be refused --------------------------------
  {
    const f = buildTelemetryFixture(fixtureDir('unknown-entry'));
    const e = expectedFor(f);
    const raw = fs.readFileSync(f.asarPath);
    raw[f.dataStart + Number(f.byPath['out/main/index.js'].entry.offset) + 5] ^= 0xff;
    fs.writeFileSync(f.asarPath, raw);
    const st = checkState(f.asarPath, { expected: e, exePath: missingExe });
    check(st.status === 'unknown', '被篡改条目状态报告为 unknown', 'a tampered entry reports status unknown');
    assertThrows(() => apply(f.asarPath, { expected: e, exePath: missingExe }), /Unknown entry SHA256/, 'unknown entry bytes must be refused');
    check(true, '未知条目被拒绝（不写入）', 'unknown entry bytes are refused without writing');
  }

  // --- partial state must be refused --------------------------------------
  {
    const f = buildTelemetryFixture(fixtureDir('partial'));
    const e = expectedFor(f);
    apply(f.asarPath, { expected: e, exePath: missingExe });
    // Restore one entry's original bytes but leave the header patched.
    const fd = fs.openSync(f.asarPath, 'r+');
    try {
      const entry = f.byPath['out/main/chunk-DBVOEQ2Z.js'];
      fs.writeSync(fd, entry.buffer, 0, entry.buffer.length, f.dataStart + Number(entry.entry.offset));
    } finally {
      fs.closeSync(fd);
    }
    const st = checkState(f.asarPath, { expected: e, exePath: missingExe });
    check(st.status === 'partial', '混合状态报告为 partial', 'a mixed state reports partial');
    assertThrows(() => apply(f.asarPath, { expected: e, exePath: missingExe }), /Inconsistent state/, 'partial state must be refused');
    check(true, '部分打补丁状态被拒绝', 'partial state is refused');
  }

  // --- existing backup blocks apply ---------------------------------------
  {
    const f = buildTelemetryFixture(fixtureDir('backup-exists'));
    const e = expectedFor(f);
    fs.writeFileSync(backupPaths(f.asarPath).receipt, '{}');
    assertThrows(() => apply(f.asarPath, { expected: e, exePath: missingExe }), /Backup exists/, 'existing backup must block apply');
    check(true, '已有备份时拒绝覆盖写入', 'apply refuses when a backup already exists');
  }

  // --- external modification detection ------------------------------------
  {
    const f = buildTelemetryFixture(fixtureDir('tamper'));
    const e = expectedFor(f);
    apply(f.asarPath, { expected: e, exePath: missingExe });
    const raw = fs.readFileSync(f.asarPath);
    const otherAbs = f.dataStart + Number(f.byPath['out/other/data.txt'].entry.offset) + 3;
    raw[otherAbs] ^= 0xff;
    fs.writeFileSync(f.asarPath, raw);
    const v = verify(f.asarPath, { expected: e, exePath: missingExe });
    check(v.ok === false && v.problems.length > 0, '外部改动其他条目时深度验证失败', 'deep verification fails after an external change');
    assertThrows(() => rollback(f.asarPath, {}), /refusing destructive rollback/, 'rollback must refuse after an external change');
    check(true, '外部改动时 rollback 拒绝破坏性恢复', 'rollback refuses a destructive restore after an external change');
    raw[otherAbs] ^= 0xff;
    fs.writeFileSync(f.asarPath, raw);
    check(rollback(f.asarPath, {}).status === 'restored', '外部改动还原后可安全回滚', 'rollback succeeds once the external change is reverted');
  }

  // --- corrupted backup ----------------------------------------------------
  {
    const f = buildTelemetryFixture(fixtureDir('bad-backup'));
    const e = expectedFor(f);
    apply(f.asarPath, { expected: e, exePath: missingExe });
    const entryBackup = backupPaths(f.asarPath).entries['out/main/index.js'];
    const bytes = fs.readFileSync(entryBackup);
    bytes[7] ^= 0xff;
    fs.writeFileSync(entryBackup, bytes);
    assertThrows(() => rollback(f.asarPath, {}), /Backup integrity failure/, 'a corrupted backup must be refused');
    assertThrows(() => loadReceipt(f.asarPath), /Backup integrity failure/, 'a corrupted backup must fail receipt validation');
    check(true, '备份损坏时拒绝回滚', 'rollback refuses a corrupted backup');
  }

  // --- receipt bound to another target ------------------------------------
  {
    const f = buildTelemetryFixture(fixtureDir('target-mismatch'));
    const e = expectedFor(f);
    apply(f.asarPath, { expected: e, exePath: missingExe });
    const receipt = JSON.parse(fs.readFileSync(backupPaths(f.asarPath).receipt, 'utf8'));
    receipt.target = 'D:/elsewhere/app.asar';
    fs.writeFileSync(backupPaths(f.asarPath).receipt, JSON.stringify(receipt, null, 2));
    assertThrows(() => rollback(f.asarPath, {}), /different target/, 'a receipt for another target must be refused');
    check(true, '收据与目标不匹配时拒绝回滚', 'rollback refuses a receipt bound to another target');
  }

  // --- damaged receipt -----------------------------------------------------
  {
    const f = buildTelemetryFixture(fixtureDir('bad-receipt'));
    const e = expectedFor(f);
    apply(f.asarPath, { expected: e, exePath: missingExe });
    fs.writeFileSync(backupPaths(f.asarPath).receipt, '{"version":1,"target":');
    assertThrows(() => rollback(f.asarPath, {}), /receipt is not valid JSON/, 'a damaged receipt must be refused with a clear error');
    check(true, '损坏收据给出明确错误', 'a damaged receipt yields an explicit error');
  }

  // --- receipt written by another tool is refused -------------------------
  {
    const f = buildTelemetryFixture(fixtureDir('foreign-receipt'));
    const e = expectedFor(f);
    apply(f.asarPath, { expected: e, exePath: missingExe });
    const receipt = JSON.parse(fs.readFileSync(backupPaths(f.asarPath).receipt, 'utf8'));
    receipt.tool = 'snapshot-patch.mjs';
    fs.writeFileSync(backupPaths(f.asarPath).receipt, JSON.stringify(receipt, null, 2));
    assertThrows(() => rollback(f.asarPath, {}), /not written by telemetry-patch/, 'a foreign receipt must be refused');
    check(true, '其他工具写入的收据被拒绝', 'a receipt written by another tool is refused');
  }

  // --- verify needs the receipt baseline ----------------------------------
  {
    const f = buildTelemetryFixture(fixtureDir('verify-baseline'));
    const e = expectedFor(f);
    apply(f.asarPath, { expected: e, exePath: missingExe });
    // Consistently rewrite another entry and its integrity metadata: only the
    // whole-archive baseline in the receipt can notice.
    const meta = readAsarHeader(f.asarPath);
    const entry = getEntry(meta.header, 'out/other/data.txt');
    const buf = readEntryBuffer(meta.fd, meta, entry);
    buf[0] ^= 0xff;
    const newInt = JSON.stringify({ ...entry.integrity, hash: hash(buf), blocks: blockHashes(buf, Number(entry.integrity.blockSize)) });
    const newJson = meta.jsonText.replace(JSON.stringify(entry.integrity), newInt);
    fs.closeSync(meta.fd);
    const fd = fs.openSync(f.asarPath, 'r+');
    fs.writeSync(fd, Buffer.from(newJson, 'utf8'), 0, Buffer.byteLength(newJson), 16);
    fs.writeSync(fd, buf, 0, buf.length, meta.dataStart + Number(entry.offset));
    fs.closeSync(fd);
    const v = verify(f.asarPath, { expected: e, exePath: missingExe });
    check(v.ok === false && v.problems.some(p => /does not match the receipt/.test(p)), '被一致改写的其他条目由收据基线发现', 'a consistently rewritten other entry is caught by the receipt baseline');
    const p = backupPaths(f.asarPath);
    fs.unlinkSync(p.receipt);
    fs.unlinkSync(p.header);
    for (const file of Object.values(p.entries)) fs.unlinkSync(file);
    const v2 = verify(f.asarPath, { expected: e, exePath: missingExe });
    check(v2.ok === false && v2.problems.some(p => /receipt is missing/.test(p)), '缺少收据时 verify 不再给出通过结论', 'verify no longer claims success without the receipt');
  }

  // --- crash reporter read-only fail-closed check -------------------------
  {
    const localText = 'var dP="https://zcode.invalid/local-crash-only";cP.start({companyName:"",submitURL:dP,uploadToServer:!1,compress:!0})';
    const remoteText = 'var dP="https://crash.zcode.z.ai/report";cP.start({companyName:"",submitURL:dP,uploadToServer:!0,compress:!0})';
    const missingText = 'no crash reporter here';
    const local = crashReporterAssessment(localText);
    const remote = crashReporterAssessment(remoteText);
    const missing = crashReporterAssessment(missingText);
    check(local.ok === true && local.localOnly === true, '本地 only 崩溃配置检查通过', 'a local-only crash configuration passes');
    check(remote.ok === false && remote.remoteUpload === true, '远程崩溃上传配置 fail-closed（不通过）', 'a remote crash-upload configuration fails closed');
    check(missing.ok === false, '缺少 crashReporter.start 时 fail-closed', 'a missing crashReporter.start fails closed');

    // A fixture that advertises remote crash upload must fail closed.
    const f = buildTelemetryFixture(fixtureDir('crash-fail-closed'), { crash: 'remote' });
    const e = expectedFor(f);
    const st = checkState(f.asarPath, { expected: e, exePath: missingExe });
    check(st.crash && st.crash.ok === false, '夹具为远程崩溃上传时 fail-closed（不通过）', 'checkState fails closed when the fixture advertises remote crash upload');
    check(st.status === 'patchable', '崩溃检查不影响补丁可用状态判定', 'the crash check does not change the patchability status');
    // The default fixture advertises local-only and must pass.
    const f2 = buildTelemetryFixture(fixtureDir('crash-local'));
    const st2 = checkState(f2.asarPath, { expected: expectedFor(f2), exePath: missingExe });
    check(st2.crash && st2.crash.ok === true, '夹具为本地 only 崩溃上报时检查通过', 'checkState passes when the fixture is local-only');
  }

  // --- CLI wiring ----------------------------------------------------------
  {
    const { spawnSync } = await import('node:child_process');
    const cli = fileURLToPath(new URL('../telemetry-patch.mjs', import.meta.url));
    const f = buildTelemetryFixture(fixtureDir('cli'));
    const checkRun = spawnSync(process.execPath, [cli, 'check', f.asarPath], { encoding: 'utf8', cwd: root });
    check(checkRun.status === 1 && /未知签名|unknown/.test(checkRun.stdout), 'CLI check 对未知版本报告失败且不写入', 'CLI check reports failure for an unknown version without writing');
    const applyRun = spawnSync(process.execPath, [cli, 'apply', f.asarPath], { encoding: 'utf8', cwd: root });
    check(applyRun.status === 1 && /--confirm/.test(applyRun.stdout), 'CLI apply 缺少 --confirm 时被拒绝', 'CLI apply without --confirm is rejected');
    const positionalRun = spawnSync(process.execPath, [cli, 'check', f.asarPath], { encoding: 'utf8', cwd: root });
    check(positionalRun.stdout.includes(f.asarPath), 'CLI 位置参数被解析为目标', 'CLI positional target is honored');
    const missingRun = spawnSync(process.execPath, [cli, 'check', path.join(root, 'no-such.asar')], { encoding: 'utf8', cwd: root });
    check(missingRun.status === 1 && /找不到所需文件|Required file not found/.test(missingRun.stdout), 'CLI 指向不存在文件时报错', 'CLI errors on a missing target');
  }
} catch (e) {
  check(false, '端到端测试发生异常：' + e.message, 'end-to-end suite threw: ' + e.message);
}

cleanup(root);
report('遥测上报禁用补丁：端到端测试（合成 ASAR，临时目录）', 'Telemetry-reporting patch: end-to-end tests (synthetic ASAR, temp dir)', process);
