// Combined real-copy integration test: copy the REAL app.asar and the REAL
// glm/zcode.cjs into a temp directory and drive both surfaces through the
// one-command orchestrator (check -> apply -> verify -> idempotent -> rollback).
// Also proves a failure on one surface is reported per item, exits non-zero and
// does not remove the other surface's backups.
//
// Run with: npm run test:telemetry:combined:real
// It copies ~320 MB and re-hashes the archive several times.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { check, skip, report, tempDir, cleanup } from './helpers.mjs';
import { applyAll, verifyAll, rollbackAll, checkAll } from '../telemetry-all.mjs';
import { defaultAsar, apply as asarApply } from '../telemetry-patch.mjs';
import { defaultAgentFile, backupPaths as agentBackupPaths } from '../agent-telemetry-patch.mjs';
import { backupPaths as asarBackupPaths } from '../telemetry-patch.mjs';

const root = tempDir('zcode-tel-combined-');
const realExe = path.join(path.dirname(path.dirname(defaultAsar)), 'ZCode.exe');
let restoredFine = false;

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

try {
  if (!fs.existsSync(defaultAsar) || !fs.existsSync(defaultAgentFile)) {
    skip('未找到真实安装，整组组合真实副本测试被跳过（不代表已验证）', 'real installation absent; the combined real-copy suite was skipped (not verified)');
  } else {
    const asarCopy = path.join(root, 'app.copy.asar');
    const agentCopy = path.join(root, 'zcode.copy.cjs');
    fs.copyFileSync(defaultAsar, asarCopy);
    fs.copyFileSync(defaultAgentFile, agentCopy);
    const asarBefore = sha256(asarCopy);
    const agentBefore = sha256(agentCopy);

    const options = { asarPath: asarCopy, agentPath: agentCopy, exePath: realExe };

    const state = checkAll(options);
    check(state.asar.ok && state.asar.status === 'patchable', '组合检查：ASAR 可打补丁', 'combined check: ASAR patchable');
    check(state.agent.ok && state.agent.status === 'patchable', '组合检查：CLI 包可打补丁', 'combined check: CLI bundle patchable');
    check(state.asar.crash && state.asar.crash.ok === true, '组合检查：崩溃上报只读 fail-closed 检查通过', 'combined check: crash-report read-only fail-closed check passes');

    const applied = applyAll(options);
    check(applied.ok === true, '一键 apply 覆盖两个上报面', 'one-command apply covers both surfaces');
    check(applied.asar.status === 'applied' && applied.asar.patches.length === 6, 'ASAR 面应用 6 条规格', 'ASAR surface applies six specs');
    check(applied.agent.status === 'applied' && applied.agent.patches.length === 1, 'CLI 面应用 1 条规格', 'CLI surface applies one spec');

    const verified = verifyAll(options);
    check(verified.ok === true, '一键 verify 覆盖两个上报面并通过', 'one-command verify covers both surfaces and passes');
    check(verified.asar.crash && verified.asar.crash.ok === true, 'verify 同时报告崩溃上报 fail-closed 检查通过', 'verify also reports the crash-report fail-closed check as passing');

    check(applyAll(options).asar.status === 'already-applied' && applyAll(options).agent.status === 'already-applied', '一键 apply 幂等', 'one-command apply is idempotent');

    const rolled = rollbackAll(options);
    check(rolled.ok === true && rolled.asar.status === 'restored' && rolled.agent.status === 'restored', '一键 rollback 覆盖两个上报面', 'one-command rollback covers both surfaces');
    check(sha256(asarCopy) === asarBefore, 'ASAR 副本回滚后逐字节还原', 'ASAR copy is byte-identical after rollback');
    check(sha256(agentCopy) === agentBefore, 'CLI 副本回滚后逐字节还原', 'CLI copy is byte-identical after rollback');
    restoredFine = sha256(asarCopy) === asarBefore && sha256(agentCopy) === agentBefore;

    // Partial failure: valid ASAR copy + tampered CLI copy. The ASAR backup must
    // survive and the overall result must be non-ok.
    {
      const asarCopy2 = path.join(root, 'app.partial.asar');
      const agentCopy2 = path.join(root, 'zcode.partial.cjs');
      fs.copyFileSync(defaultAsar, asarCopy2);
      const tampered = fs.readFileSync(defaultAgentFile);
      tampered[20] ^= 0xff;
      fs.writeFileSync(agentCopy2, tampered);
      const partial = applyAll({ asarPath: asarCopy2, agentPath: agentCopy2, exePath: realExe });
      check(partial.ok === false, '一个上报面失败时整体返回非成功', 'a failure on one surface makes the overall result non-ok');
      check(partial.asar.ok === true && partial.agent.ok === false, '分项状态区分成功与失败', 'per-item status distinguishes success from failure');
      check(fs.existsSync(asarBackupPaths(asarCopy2).receipt) && fs.existsSync(agentBackupPaths(agentCopy2).receipt) === false, '失败时已写入的备份保留，未产生的备份不臆造', 'on failure existing backups are kept and no backup is invented');
      rollbackAll({ asarPath: asarCopy2, agentPath: agentCopy2, exePath: realExe });
    }

    // Partial install: only the ASAR surface applied -> checkAll must warn.
    {
      const asarCopy3 = path.join(root, 'app.partialwarn.asar');
      const agentCopy3 = path.join(root, 'zcode.partialwarn.cjs');
      fs.copyFileSync(defaultAsar, asarCopy3);
      fs.copyFileSync(defaultAgentFile, agentCopy3);
      asarApply(asarCopy3, { exePath: realExe });
      const state = checkAll({ asarPath: asarCopy3, agentPath: agentCopy3, exePath: realExe });
      check(state.asar.status === 'applied' && state.agent.status === 'patchable', '分项状态显式区分已打补丁/可打补丁', 'per-surface status explicitly distinguishes applied from patchable');
      check(state.warnings.length === 1, '仅一个上报面已打补丁时给出部分安装警告', 'a warning is emitted when only one surface is patched');
      rollbackAll({ asarPath: asarCopy3, agentPath: agentCopy3, exePath: realExe });
    }
  }
} catch (e) {
  check(false, '组合真实副本测试发生异常：' + e.message, 'combined real-copy test threw: ' + e.message);
}

cleanup(root);
report('遥测补丁组合真实副本测试：一键覆盖 ASAR 与 CLI（真实安装只读）', 'Combined telemetry real-copy test: one command covers ASAR and CLI (real install read-only)', process);
if (!restoredFine && fs.existsSync(defaultAsar)) process.exitCode = 1;
