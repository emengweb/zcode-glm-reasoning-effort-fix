// Opt-in, heavy integration test: copy the REAL app.asar into a temp directory
// and run the full apply -> verify -> idempotent -> rollback cycle there using
// the pinned version signature. The real installation is only read.
//
// Run with: npm run test:snapshot:real
// It copies ~300 MB and re-hashes the archive several times.
import fs from 'node:fs';
import path from 'node:path';
import { check, skip, report, tempDir, cleanup } from './helpers.mjs';
import {
  apply, verify, rollback, checkState, hashRegion, defaultAsar, KNOWN_VERSION,
} from '../snapshot-patch.mjs';

const root = tempDir('zcode-snap-real-');
const realExe = path.join(path.dirname(path.dirname(defaultAsar)), 'ZCode.exe');
let restoredFine = false;

try {
  if (!fs.existsSync(defaultAsar)) {
    skip('未找到真实安装，整组真实副本测试被跳过（不代表已验证）', 'real installation absent; the whole real-copy suite was skipped (not verified)');
  } else {
    const copy = path.join(root, 'app.copy.asar');
    fs.copyFileSync(defaultAsar, copy);
    const fd0 = fs.openSync(copy, 'r');
    const originalSha = hashRegion(fd0, 0, fs.fstatSync(fd0).size);
    fs.closeSync(fd0);

    const state = checkState(copy, { exePath: realExe });
    check(state.status === 'patchable', '真实副本初始状态：可打补丁', 'real copy initial state: patchable');
    check(state.hostSha === KNOWN_VERSION.hostOriginalSha256, '真实副本主机哈希与版本签名一致', 'real copy host hash matches the pinned signature');

    const applied = apply(copy, { exePath: realExe });
    check(applied.status === 'applied' && applied.patches.length === 5, '真实副本 apply 成功（5 个入口）', 'real copy apply succeeds (five entrypoints)');

    const verified = verify(copy, { exePath: realExe });
    check(verified.ok === true && verified.status === 'applied', '真实副本深度验证通过', 'real copy deep verification passes');
    check(verified.checked === 26773 && verified.skippedUnpacked === 12, '真实副本逐条目完整性校验通过', 'real copy per-entry integrity verified');
    check(verified.asarSha !== originalSha, '真实副本 ASAR 哈希已变化', 'real copy archive hash changed');

    const again = apply(copy, { exePath: realExe });
    check(again.status === 'already-applied', '真实副本重复 apply 幂等', 'real copy repeat apply is idempotent');

    const rolled = rollback(copy, {});
    const fd1 = fs.openSync(copy, 'r');
    const finalSha = hashRegion(fd1, 0, fs.fstatSync(fd1).size);
    fs.closeSync(fd1);
    check(rolled.status === 'restored', '真实副本 rollback 成功', 'real copy rollback succeeds');
    check(finalSha === originalSha, '真实副本回滚后整个 ASAR 逐字节还原', 'real copy archive is byte-identical after rollback');
    restoredFine = finalSha === originalSha;
  }
} catch (e) {
  check(false, '真实副本测试发生异常：' + e.message, 'real-copy test threw: ' + e.message);
}

cleanup(root);
report('快照补丁真实副本集成测试（真实安装只读）', 'Snapshot patch real-copy integration test (real install read-only)', process);
if (!restoredFine && fs.existsSync(defaultAsar)) process.exitCode = 1;
