// Suite 4: interaction with the existing repository-snapshot privacy patch.
// Both patches touch the same ASAR header, so this suite proves they compose in
// either application order and roll back cleanly in LIFO order, and that an
// out-of-order rollback is refused instead of corrupting the archive.
import fs from 'node:fs';
import path from 'node:path';
import { check, report, tempDir, cleanup, assertThrows } from './helpers.mjs';
import { buildTelemetryFixture } from './fixture-telemetry-asar.mjs';
import * as T from '../telemetry-patch.mjs';
import * as S from '../snapshot-patch.mjs';

const root = tempDir('zcode-tel-interaction-');
const missingExe = path.join(root, 'no-such.exe');
const ENTRIES = Object.keys(T.KNOWN_VERSION.entries);

function makeFixture(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return buildTelemetryFixture(dir, { withHost: true });
}

function expectedFor(f) {
  const texts = {};
  for (const p of ENTRIES) texts[p] = f.byPath[p].buffer.toString('utf8');
  const transformed = T.transformEntries(texts);
  const tel = { ...T.KNOWN_VERSION, appVersion: 'fixture', dataStart: f.dataStart, jsonLen: f.jsonLen, entries: {} };
  for (const p of ENTRIES) {
    tel.entries[p] = {
      offset: f.byPath[p].entry.offset,
      size: f.byPath[p].buffer.length,
      originalSha256: T.hash(f.byPath[p].buffer),
      patchedSha256: T.hash(Buffer.from(transformed.texts[p], 'utf8')),
    };
  }
  const host = f.byPath['out/host/index.js'];
  const hostPatched = S.transformHost(host.buffer.toString('utf8')).text;
  const snap = {
    ...S.KNOWN_VERSION,
    appVersion: 'fixture',
    dataStart: f.dataStart,
    jsonLen: f.jsonLen,
    hostEntryOffset: host.entry.offset,
    hostEntrySize: host.buffer.length,
    hostOriginalSha256: T.hash(host.buffer),
    hostPatchedSha256: T.hash(Buffer.from(hostPatched, 'utf8')),
  };
  return { tel, snap };
}

function byteIdentical(file, expected) {
  return Buffer.compare(fs.readFileSync(file), expected) === 0;
}

try {
  // --- order A: snapshot first, then telemetry ----------------------------
  {
    const f = makeFixture('snapshot-then-telemetry');
    const e = expectedFor(f);
    check(S.apply(f.asarPath, { expected: e.snap, exePath: missingExe }).status === 'applied', '顺序 A：先应用快照补丁', 'order A: snapshot patch applied first');
    check(S.verify(f.asarPath, { expected: e.snap, exePath: missingExe }).ok, '顺序 A：快照补丁验证通过', 'order A: snapshot patch verifies');
    check(T.apply(f.asarPath, { expected: e.tel, exePath: missingExe }).status === 'applied', '顺序 A：再应用遥测补丁', 'order A: telemetry patch applied second');
    check(T.verify(f.asarPath, { expected: e.tel, exePath: missingExe }).ok, '顺序 A：遥测补丁验证通过', 'order A: telemetry patch verifies');
    // Both receipts coexist under distinct namespaces.
    const telBackup = T.backupPaths(f.asarPath);
    const snapBackup = S.backupPaths(f.asarPath);
    check(fs.existsSync(telBackup.receipt) && fs.existsSync(snapBackup.receipt), '顺序 A：两套备份收据并存且互不覆盖', 'order A: both receipts coexist without overwriting each other');
    // Once telemetry is on top, the snapshot receipt baseline no longer matches
    // the archive hash: this interaction is expected and documented.
    const snapVerifyAfter = S.verify(f.asarPath, { expected: e.snap, exePath: missingExe });
    check(snapVerifyAfter.ok === false && snapVerifyAfter.problems.some(p => /does not match the receipt/.test(p)), '顺序 A：后应用的补丁会改变归档哈希（已知交互，需按 LIFO 回滚）', 'order A: a later patch changes the archive hash (known interaction; roll back LIFO)');
    check(T.rollback(f.asarPath, {}).status === 'restored', '顺序 A：先回滚遥测补丁', 'order A: telemetry rolled back first');
    check(S.rollback(f.asarPath, {}).status === 'restored', '顺序 A：再回滚快照补丁', 'order A: snapshot rolled back second');
    check(byteIdentical(f.asarPath, f.packageBytes), '顺序 A：回滚后逐字节还原', 'order A: archive is byte-identical after rollback');
  }

  // --- order B: telemetry first, then snapshot ----------------------------
  {
    const f = makeFixture('telemetry-then-snapshot');
    const e = expectedFor(f);
    check(T.apply(f.asarPath, { expected: e.tel, exePath: missingExe }).status === 'applied', '顺序 B：先应用遥测补丁', 'order B: telemetry patch applied first');
    check(T.verify(f.asarPath, { expected: e.tel, exePath: missingExe }).ok, '顺序 B：遥测补丁验证通过', 'order B: telemetry patch verifies');
    check(S.apply(f.asarPath, { expected: e.snap, exePath: missingExe }).status === 'applied', '顺序 B：再应用快照补丁', 'order B: snapshot patch applied second');
    check(S.verify(f.asarPath, { expected: e.snap, exePath: missingExe }).ok, '顺序 B：快照补丁验证通过', 'order B: snapshot patch verifies');
    check(S.rollback(f.asarPath, {}).status === 'restored', '顺序 B：先回滚快照补丁', 'order B: snapshot rolled back first');
    check(T.rollback(f.asarPath, {}).status === 'restored', '顺序 B：再回滚遥测补丁', 'order B: telemetry rolled back second');
    check(byteIdentical(f.asarPath, f.packageBytes), '顺序 B：回滚后逐字节还原', 'order B: archive is byte-identical after rollback');
  }

  // --- out-of-order rollback is refused -----------------------------------
  {
    const f = makeFixture('out-of-order');
    const e = expectedFor(f);
    S.apply(f.asarPath, { expected: e.snap, exePath: missingExe });
    T.apply(f.asarPath, { expected: e.tel, exePath: missingExe });
    assertThrows(() => S.rollback(f.asarPath, {}), /refusing destructive rollback/, 'rolling back the older patch first must be refused');
    check(true, '乱序回滚（先回滚较早补丁）被拒绝，不破坏归档', 'an out-of-order rollback (older patch first) is refused without corrupting the archive');
    // The correct LIFO order still works afterwards.
    check(T.rollback(f.asarPath, {}).status === 'restored' && S.rollback(f.asarPath, {}).status === 'restored', '乱序被拒后仍可按 LIFO 正常回滚', 'after the refusal the archive still rolls back in LIFO order');
    check(byteIdentical(f.asarPath, f.packageBytes), '乱序测试后逐字节还原', 'archive is byte-identical after the out-of-order test');
  }

  // --- telemetry check on a snapshot-patched archive ----------------------
  {
    const f = makeFixture('check-after-snapshot');
    const e = expectedFor(f);
    S.apply(f.asarPath, { expected: e.snap, exePath: missingExe });
    const st = T.checkState(f.asarPath, { expected: e.tel, exePath: missingExe });
    check(st.status === 'patchable' && st.problems.length === 0, '快照补丁已应用时遥测补丁仍报告可打补丁', 'with the snapshot patch applied the telemetry patch still reports patchable');
  }
} catch (e) {
  check(false, '组合测试发生异常：' + e.message, 'interaction suite threw: ' + e.message);
}

cleanup(root);
report('遥测补丁与快照补丁组合：两种顺序与回滚兼容性（合成 ASAR）', 'Telemetry and snapshot patch interaction: both orders and rollback compatibility (synthetic ASAR)', process);
