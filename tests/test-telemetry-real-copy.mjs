// Opt-in, heavy integration test: copy the REAL app.asar into a temp directory
// and run the full telemetry apply -> verify -> idempotent -> rollback cycle
// there using the pinned version signature. Because the real installation
// already carries the repository-snapshot patch, this also proves the telemetry
// patch composes with an already-patched archive and leaves it untouched after
// rollback. The real installation is only read.
//
// Run with: npm run test:telemetry:real
// It copies ~300 MB and re-hashes the archive several times.
import fs from 'node:fs';
import path from 'node:path';
import { check, skip, report, tempDir, cleanup } from './helpers.mjs';
import {
  apply, verify, rollback, checkState, hashRegion, defaultAsar, KNOWN_VERSION,
} from '../telemetry-patch.mjs';
import { checkState as snapshotCheckState, verify as snapshotVerify, backupPaths as snapshotBackupPaths } from '../snapshot-patch.mjs';

const root = tempDir('zcode-tel-real-');
const realExe = path.join(path.dirname(path.dirname(defaultAsar)), 'ZCode.exe');
let restoredFine = false;

try {
  if (!fs.existsSync(defaultAsar)) {
    skip('未找到真实安装，整组真实副本测试被跳过（不代表已验证）', 'real installation absent; the whole real-copy suite was skipped (not verified)');
  } else {
    const copy = path.join(root, 'app.copy.asar');
    fs.copyFileSync(defaultAsar, copy);
    // Bring the real installation's snapshot-patch backups along so the
    // composition check can verify that patch against the copy.
    const realSnapPaths = snapshotBackupPaths(defaultAsar);
    const copySnapPaths = snapshotBackupPaths(copy);
    let snapshotBackupsCopied = true;
    for (const key of ['header', 'host', 'receipt']) {
      if (fs.existsSync(realSnapPaths[key])) fs.copyFileSync(realSnapPaths[key], copySnapPaths[key]);
      else snapshotBackupsCopied = false;
    }
    const fd0 = fs.openSync(copy, 'r');
    const originalSha = hashRegion(fd0, 0, fs.fstatSync(fd0).size);
    fs.closeSync(fd0);

    const snapshotState = snapshotCheckState(copy, { exePath: realExe });
    const snapshotApplied = snapshotState.status === 'applied';

    const state = checkState(copy, { exePath: realExe });
    check(state.status === 'patchable', '真实副本初始状态：可打补丁', 'real copy initial state: patchable');
    check(Object.keys(KNOWN_VERSION.entries).every(p => state.states.find(s => s.entryPath === p && s.state === 'original')), '真实副本 4 个目标条目均与版本签名一致', 'all four target entries match the pinned signature');

    const applied = apply(copy, { exePath: realExe });
    check(applied.status === 'applied' && applied.patches.length === 6, '真实副本 apply 成功（6 条规格）', 'real copy apply succeeds (six specs)');

    const verified = verify(copy, { exePath: realExe });
    check(verified.ok === true && verified.status === 'applied', '真实副本深度验证通过', 'real copy deep verification passes');
    check(verified.checked === 26773 && verified.skippedUnpacked === 12, '真实副本逐条目完整性校验通过', 'real copy per-entry integrity verified');

    check(apply(copy, { exePath: realExe }).status === 'already-applied', '真实副本重复 apply 幂等', 'real copy repeat apply is idempotent');

    const rolled = rollback(copy, {});
    const fd1 = fs.openSync(copy, 'r');
    const finalSha = hashRegion(fd1, 0, fs.fstatSync(fd1).size);
    fs.closeSync(fd1);
    check(rolled.status === 'restored', '真实副本 rollback 成功', 'real copy rollback succeeds');
    check(finalSha === originalSha, '真实副本回滚后整个 ASAR 逐字节还原', 'real copy archive is byte-identical after rollback');
    restoredFine = finalSha === originalSha;

    if (snapshotApplied && snapshotBackupsCopied) {
      const snapAfter = snapshotVerify(copy, { exePath: realExe });
      check(snapAfter.ok === true, '遥测补丁循环后已有快照补丁仍验证通过（互不破坏）', 'after the telemetry cycle the existing snapshot patch still verifies (no interference)');
    } else {
      skip('真实副本未携带快照补丁收据，跳过组合验证', 'the real copy does not carry the snapshot patch receipt; composition check skipped');
    }
  }
} catch (e) {
  check(false, '真实副本测试发生异常：' + e.message, 'real-copy test threw: ' + e.message);
}

cleanup(root);
report('遥测补丁真实副本集成测试（真实安装只读）', 'Telemetry patch real-copy integration test (real install read-only)', process);
if (!restoredFine && fs.existsSync(defaultAsar)) process.exitCode = 1;
