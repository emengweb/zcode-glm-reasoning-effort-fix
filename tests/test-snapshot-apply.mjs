// Suite 2: end-to-end apply / verify / rollback on a synthetic ASAR in a temp
// directory. The real installation is never written to.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, report, tempDir, cleanup, assert, assertEqual, assertThrows } from './helpers.mjs';
import { buildFixture, hostFixtureText } from './fixture-asar.mjs';
import {
  hash, transformHost, apply, verify, rollback, checkState, readAsarHeader, getEntry,
  readEntryBuffer, blockHashes, KNOWN_VERSION, HOST_ENTRY_PATH, backupPaths, loadReceipt,
} from '../snapshot-patch.mjs';

const root = tempDir('zcode-snap-apply-');
const missingExe = path.join(root, 'no-such.exe');

function expectedFor(fixture) {
  const transformed = transformHost(fixture.host.text);
  return {
    ...KNOWN_VERSION,
    appVersion: 'fixture',
    dataStart: fixture.dataStart,
    jsonLen: fixture.jsonLen,
    hostEntryOffset: fixture.host.offset,
    hostEntrySize: fixture.host.size,
    hostOriginalSha256: fixture.host.sha256,
    hostPatchedSha256: hash(Buffer.from(transformed.text, 'utf8')),
  };
}

function fixtureDir(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readEntryBytes(asarPath, entryPath) {
  const meta = readAsarHeader(asarPath);
  try {
    const entry = getEntry(meta.header, entryPath);
    return readEntryBuffer(meta.fd, meta, entry);
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

// Rewrites an entry's bytes and its integrity metadata together, keeping every
// length unchanged, so only a whole-archive baseline can notice the change.
function rewriteEntryConsistently(asarPath, entryPath, mutate) {
  const meta = readAsarHeader(asarPath);
  try {
    const entry = getEntry(meta.header, entryPath);
    const buf = readEntryBuffer(meta.fd, meta, entry);
    mutate(buf);
    const oldIntJson = JSON.stringify(entry.integrity);
    const newIntJson = JSON.stringify({
      ...entry.integrity,
      hash: hash(buf),
      blocks: blockHashes(buf, Number(entry.integrity.blockSize)),
    });
    const newText = meta.jsonText.replace(oldIntJson, newIntJson);
    const fd = fs.openSync(asarPath, 'r+');
    try {
      fs.writeSync(fd, Buffer.from(newText, 'utf8'), 0, Buffer.byteLength(newText), 16);
      fs.writeSync(fd, buf, 0, buf.length, meta.dataStart + Number(entry.offset));
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    fs.closeSync(meta.fd);
  }
}

try {
  // --- happy path ----------------------------------------------------------
  const f1 = buildFixture(fixtureDir('happy'));
  const e1 = expectedFor(f1);
  check(f1.jsonLen % 4 !== 0, '夹具头部带非零填充（贴近真实 ASAR）', 'fixture header has non-zero padding (like the real ASAR)');

  const before = checkState(f1.asarPath, { expected: e1, exePath: missingExe });
  check(before.status === 'patchable' && before.integrity.ok, '初始状态：可打补丁且完整性自洽', 'initial state: patchable and integrity consistent');

  const applied = apply(f1.asarPath, { expected: e1, exePath: missingExe });
  check(applied.status === 'applied' && applied.patches.length === 5, 'apply 应用全部 5 个补丁', 'apply installs all five patches');

  const verify1 = verify(f1.asarPath, { expected: e1, exePath: missingExe });
  check(verify1.ok === true, 'apply 后深度验证通过', 'deep verification passes after apply');
  check(verify1.status === 'applied', 'apply 后状态为已打补丁', 'post-apply status is applied');
  check(verify1.checked === 4 && verify1.skippedUnpacked === 0, '校验了所有 4 个条目（含空文件）', 'all four entries verified (including the zero-byte file)');
  const emptyAfter = readEntryBytes(f1.asarPath, 'out/other/empty.txt');
  check(emptyAfter.length === 0, '空文件条目不报错且保持为空', 'zero-byte entry stays empty and verifies');

  const otherAfter = readEntryBytes(f1.asarPath, 'out/other/data.txt');
  check(Buffer.compare(otherAfter, f1.otherEntry.buffer) === 0, '其他条目数据逐字节未变', 'other entry bytes are unchanged');
  const pkgAfter = readEntryBytes(f1.asarPath, 'package.json');
  check(pkgAfter.toString('utf8').includes('fixture'), 'package.json 条目未变', 'package.json entry is unchanged');

  const intBefore = headerIntegrities(f1.asarPath);
  check(intBefore['/out/host/index.js'].hash !== e1.hostOriginalSha256 && intBefore['/out/host/index.js'].hash === e1.hostPatchedSha256, '主机条目完整性已更新为新哈希', 'host entry integrity updated to the new hash');
  check(intBefore['/out/host/index.js'].blocks.length > 1, '多块 block 列表已重算', 'multi-block list recomputed');

  const verify2 = apply(f1.asarPath, { expected: e1, exePath: missingExe });
  check(verify2.status === 'already-applied', '重复 apply 幂等', 'repeat apply is idempotent');

  // Backup file exists and is signed by the receipt.
  const receipt1 = loadReceipt(f1.asarPath);
  check(receipt1 && receipt1.before.hostSha256 === e1.hostOriginalSha256 && receipt1.after.hostSha256 === e1.hostPatchedSha256, '备份收据记录了前后哈希', 'backup receipt records before/after hashes');

  const rolled = rollback(f1.asarPath, {});
  check(rolled.status === 'restored', 'rollback 成功恢复', 'rollback restores successfully');
  const restoredBytes = fs.readFileSync(f1.asarPath);
  check(Buffer.compare(restoredBytes, f1.packageBytes) === 0, '回滚后整个 ASAR 与原始逐字节一致', 'archive is byte-identical to the original after rollback');
  check(!fs.existsSync(backupPaths(f1.asarPath).receipt), '回滚后收据已清理', 'receipt removed after rollback');

  const after1 = checkState(f1.asarPath, { expected: e1, exePath: missingExe });
  check(after1.status === 'patchable', '回滚后状态恢复为可打补丁', 'status returns to patchable after rollback');

  // --- unknown host must be refused ---------------------------------------
  const f2 = buildFixture(fixtureDir('unknown'));
  const e2 = expectedFor(f2);
  const raw2 = fs.readFileSync(f2.asarPath);
  raw2[f2.dataStart + Number(f2.host.offset) + 5] ^= 0xff;
  fs.writeFileSync(f2.asarPath, raw2);
  assertThrows(() => apply(f2.asarPath, { expected: e2, exePath: missingExe }), /Unknown host SHA256/, 'unknown host must be refused');
  check(true, '未知主机文件被拒绝（不做任何写入）', 'unknown host file is refused without writing');
  const unknownState = checkState(f2.asarPath, { expected: e2, exePath: missingExe });
  check(unknownState.status === 'unknown', '未知主机状态报告为 unknown', 'unknown host status reported as unknown');

  // --- reject when a backup already exists --------------------------------
  const f3 = buildFixture(fixtureDir('backup-exists'));
  const e3 = expectedFor(f3);
  fs.writeFileSync(backupPaths(f3.asarPath).receipt, '{}');
  assertThrows(() => apply(f3.asarPath, { expected: e3, exePath: missingExe }), /Backup exists/, 'existing backup must block apply');
  check(true, '已有备份时拒绝覆盖写入', 'apply refuses when a backup already exists');

  // --- external modification detection -----------------------------------
  const f4 = buildFixture(fixtureDir('tamper'));
  const e4 = expectedFor(f4);
  apply(f4.asarPath, { expected: e4, exePath: missingExe });
  const raw4 = fs.readFileSync(f4.asarPath);
  const otherAbs = f4.dataStart + Number(f4.otherEntry.entry.offset) + 3;
  raw4[otherAbs] ^= 0xff;
  fs.writeFileSync(f4.asarPath, raw4);
  const verify4 = verify(f4.asarPath, { expected: e4, exePath: missingExe });
  check(verify4.ok === false && verify4.problems.length > 0, '外部改动其他条目时深度验证失败', 'deep verification fails after external modification');
  assertThrows(() => rollback(f4.asarPath, {}), /refusing destructive rollback/, 'rollback must refuse after external modification');
  check(true, '外部改动时 rollback 拒绝破坏性恢复', 'rollback refuses destructive restore after external modification');
  raw4[otherAbs] ^= 0xff;
  fs.writeFileSync(f4.asarPath, raw4);
  const rolled4 = rollback(f4.asarPath, {});
  check(rolled4.status === 'restored', '外部改动还原后可安全回滚', 'rollback succeeds once the external change is reverted');

  // --- corrupted backup ----------------------------------------------------
  const f5 = buildFixture(fixtureDir('bad-backup'));
  const e5 = expectedFor(f5);
  apply(f5.asarPath, { expected: e5, exePath: missingExe });
  const hostBackup = backupPaths(f5.asarPath).host;
  const backupBytes = fs.readFileSync(hostBackup);
  backupBytes[7] ^= 0xff;
  fs.writeFileSync(hostBackup, backupBytes);
  assertThrows(() => rollback(f5.asarPath, {}), /Backup integrity failure/, 'corrupted backup must be refused');
  assertThrows(() => loadReceipt(f5.asarPath), /Backup integrity failure/, 'corrupted backup must fail receipt validation');
  check(true, '备份损坏时拒绝回滚', 'rollback refuses a corrupted backup');

  // --- receipt bound to another target ------------------------------------
  const f6 = buildFixture(fixtureDir('target-mismatch'));
  const e6 = expectedFor(f6);
  apply(f6.asarPath, { expected: e6, exePath: missingExe });
  const receipt6 = JSON.parse(fs.readFileSync(backupPaths(f6.asarPath).receipt, 'utf8'));
  receipt6.target = 'D:/elsewhere/app.asar';
  fs.writeFileSync(backupPaths(f6.asarPath).receipt, JSON.stringify(receipt6, null, 2));
  assertThrows(() => rollback(f6.asarPath, {}), /different target/, 'receipt for another target must be refused');
  check(true, '收据与目标不匹配时拒绝回滚', 'rollback refuses a receipt bound to another target');

  // --- single-block integrity (like the real archive) ---------------------
  const f7 = buildFixture(fixtureDir('single-block'), { blockSize: 4194304 });
  const e7 = expectedFor(f7);
  const applied7 = apply(f7.asarPath, { expected: e7, exePath: missingExe });
  const verify7 = verify(f7.asarPath, { expected: e7, exePath: missingExe });
  const int7 = headerIntegrities(f7.asarPath);
  check(applied7.status === 'applied' && verify7.ok, '单块完整性（贴近真实 blockSize）同样通过', 'single-block integrity (real blockSize) also passes');
  check(int7['/out/host/index.js'].blocks.length === 1 && int7['/out/host/index.js'].hash === e7.hostPatchedSha256, '单块哈希已更新', 'single-block hash updated');

  // --- marker present in the patched bundle -------------------------------
  const patchedHost = readEntryBytes(f7.asarPath, HOST_ENTRY_PATH).toString('utf8');
  check(patchedHost.includes('snapshot-privacy:disabled') && !patchedHost.includes('captureScheduler.schedule'), '已补丁主机包含标记且不再调度采集', 'patched host carries the marker and no longer schedules capture');

  // --- receipt is final before anything is written ------------------------
  const f9 = buildFixture(fixtureDir('interrupted'));
  const e9 = expectedFor(f9);
  apply(f9.asarPath, { expected: e9, exePath: missingExe });
  const p9 = backupPaths(f9.asarPath);
  const receipt9 = JSON.parse(fs.readFileSync(p9.receipt, 'utf8'));
  check(receipt9.after.asarSha256 === hash(fs.readFileSync(f9.asarPath)), '收据在写入前即带最终 after 哈希（无 null 收据）', 'receipt already carries the final after hash (no null receipt)');
  check(receipt9.before.fileSize === fs.statSync(f9.asarPath).size, '收据记录原始文件大小', 'receipt records the original file size');

  // Simulate an interrupted apply: header restored, host still patched (mixed).
  const mixed = fs.readFileSync(f9.asarPath);
  fs.readFileSync(p9.header).copy(mixed, 8);
  fs.writeFileSync(f9.asarPath, mixed);
  const rolled9 = rollback(f9.asarPath, {});
  check(rolled9.status === 'restored', '中断的中间状态被自动识别', 'interrupted mixed state is auto-detected');
  check(Buffer.compare(fs.readFileSync(f9.asarPath), f9.packageBytes) === 0, '中断状态回滚后逐字节还原', 'mixed state is restored byte-identically');

  // A torn write inside a region must be recoverable too: both regions are
  // rewritten from the backups, so only bytes outside them have to be intact.
  const f9b = buildFixture(fixtureDir('partial-write'));
  const e9b = expectedFor(f9b);
  apply(f9b.asarPath, { expected: e9b, exePath: missingExe });
  const partial = fs.readFileSync(f9b.asarPath);
  Buffer.alloc(64, 0xff).copy(partial, 8 + 32);
  Buffer.alloc(64, 0xee).copy(partial, f9b.dataStart + Number(f9b.host.offset) + 8);
  fs.writeFileSync(f9b.asarPath, partial);
  const rolled9b = rollback(f9b.asarPath, {});
  check(rolled9b.status === 'restored' && Buffer.compare(fs.readFileSync(f9b.asarPath), f9b.packageBytes) === 0, '区域内的半截写入也能安全回滚', 'a torn write inside the regions is recovered safely');

  // A changed file size must never be "recovered" silently.
  const f9c = buildFixture(fixtureDir('grown'));
  const e9c = expectedFor(f9c);
  apply(f9c.asarPath, { expected: e9c, exePath: missingExe });
  fs.appendFileSync(f9c.asarPath, Buffer.from([0]));
  assertThrows(() => rollback(f9c.asarPath, {}), /refusing destructive rollback/, 'a size change must block rollback');
  check(true, '文件长度变化时拒绝回滚', 'a size change blocks rollback');

  // --- legacy / interrupted receipt without an after hash -----------------
  const f10 = buildFixture(fixtureDir('legacy-receipt'));
  const e10 = expectedFor(f10);
  apply(f10.asarPath, { expected: e10, exePath: missingExe });
  const p10 = backupPaths(f10.asarPath);
  const receipt10 = JSON.parse(fs.readFileSync(p10.receipt, 'utf8'));
  receipt10.after.asarSha256 = null;
  delete receipt10.before.fileSize;
  fs.writeFileSync(p10.receipt, JSON.stringify(receipt10, null, 2));
  const rolled10 = rollback(f10.asarPath, {});
  check(rolled10.status === 'restored' && Buffer.compare(fs.readFileSync(f10.asarPath), f10.packageBytes) === 0, '旧版/中断收据在无外部改动时仍可恢复', 'legacy/interrupted receipt still restores when nothing else changed');

  // --- an externally modified byte outside the patchable regions still blocks
  const f11 = buildFixture(fixtureDir('legacy-receipt-tampered'));
  const e11 = expectedFor(f11);
  apply(f11.asarPath, { expected: e11, exePath: missingExe });
  const p11 = backupPaths(f11.asarPath);
  const receipt11 = JSON.parse(fs.readFileSync(p11.receipt, 'utf8'));
  receipt11.after.asarSha256 = null;
  delete receipt11.before.fileSize;
  fs.writeFileSync(p11.receipt, JSON.stringify(receipt11, null, 2));
  const raw11 = fs.readFileSync(f11.asarPath);
  raw11[f11.dataStart + Number(f11.otherEntry.entry.offset) + 3] ^= 0xff;
  fs.writeFileSync(f11.asarPath, raw11);
  assertThrows(() => rollback(f11.asarPath, {}), /refusing destructive rollback/, 'external change outside the patched regions must block recovery');
  check(true, '无 after 哈希时，区域外改动仍被拒绝恢复', 'with no after hash, changes outside the regions still block rollback');

  // --- a damaged receipt must fail with a clear message -------------------
  const f12 = buildFixture(fixtureDir('bad-receipt-json'));
  const e12 = expectedFor(f12);
  apply(f12.asarPath, { expected: e12, exePath: missingExe });
  fs.writeFileSync(backupPaths(f12.asarPath).receipt, '{"version":1,"target":');
  assertThrows(() => rollback(f12.asarPath, {}), /receipt is not valid JSON/, 'damaged receipt must be refused with a clear error');
  check(true, '损坏收据给出明确错误', 'damaged receipt yields an explicit error');

  // --- verify needs the receipt baseline ----------------------------------
  const f13 = buildFixture(fixtureDir('verify-baseline'));
  const e13 = expectedFor(f13);
  apply(f13.asarPath, { expected: e13, exePath: missingExe });
  rewriteEntryConsistently(f13.asarPath, 'out/other/data.txt', buf => { buf[0] ^= 0xff; });
  const v13 = verify(f13.asarPath, { expected: e13, exePath: missingExe });
  check(v13.ok === false && v13.problems.some(p => /does not match the receipt/.test(p)), '被一致改写的其他条目由收据基线发现', 'a consistently rewritten other entry is caught by the receipt baseline');
  for (const key of ['receipt', 'host', 'header']) fs.unlinkSync(backupPaths(f13.asarPath)[key]);
  const v13b = verify(f13.asarPath, { expected: e13, exePath: missingExe });
  check(v13b.ok === false && v13b.problems.some(p => /receipt is missing/.test(p)), '缺少收据时 verify 不再给出通过结论', 'verify no longer claims success without the receipt');
  // --- CLI wiring (check + confirm guard) on a fixture --------------------
  {
    const { spawnSync } = await import('node:child_process');
    const cli = fileURLToPath(new URL('../snapshot-patch.mjs', import.meta.url));
    const f8 = buildFixture(fixtureDir('cli'));
    const checkRun = spawnSync(process.execPath, [cli, 'check', '--asar', f8.asarPath], { encoding: 'utf8', cwd: root });
    check(checkRun.status === 0 && /UNKNOWN/.test(checkRun.stdout) && /Refusing/.test(checkRun.stdout + checkRun.stderr) === false, 'CLI check 对未知版本报告 UNKNOWN 且不写入', 'CLI check reports UNKNOWN for an unknown version without writing');
    const applyRun = spawnSync(process.execPath, [cli, 'apply', '--asar', f8.asarPath], { encoding: 'utf8', cwd: root });
    check(applyRun.status === 1 && /--confirm/.test(applyRun.stderr), 'CLI apply 缺少 --confirm 时被拒绝', 'CLI apply without --confirm is rejected');
    const verifyRun = spawnSync(process.execPath, [cli, 'verify', '--asar', f8.asarPath], { encoding: 'utf8', cwd: root });
    check(verifyRun.status === 1 && /FAILED/.test(verifyRun.stdout), 'CLI verify 对未打补丁的归档报告失败', 'CLI verify reports failure for an unpatched archive');
    // The npm scripts and Makefile pass the target positionally: it must not be
    // silently ignored in favour of the default installation.
    const positionalRun = spawnSync(process.execPath, [cli, 'check', f8.asarPath], { encoding: 'utf8', cwd: root });
    check(positionalRun.status === 0 && positionalRun.stdout.includes(f8.asarPath), 'CLI 位置参数被解析为目标（不再静默回退到默认安装）', 'CLI positional target is honored (no silent fallback to the default install)');
    const missingRun = spawnSync(process.execPath, [cli, 'check', path.join(root, 'no-such.asar')], { encoding: 'utf8', cwd: root });
    check(missingRun.status === 1 && /找不到所需文件|Required file not found/.test(missingRun.stderr), 'CLI 位置参数指向不存在文件时报错而非检查默认安装', 'CLI errors on a missing positional target instead of checking the default install');
  }
} catch (e) {
  check(false, '端到端测试发生异常：' + e.message, 'end-to-end suite threw: ' + e.message);
}

cleanup(root);
report('快照补丁端到端测试（合成 ASAR，临时目录）', 'Snapshot patch end-to-end tests (synthetic ASAR, temp dir)', process);
