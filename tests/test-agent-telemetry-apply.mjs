// Suite A3: Agent hard-block end-to-end on a synthetic plain file in a temp
// directory, plus refusal paths (unknown SHA, existing backup, external change,
// corrupted backup, wrong target, damaged receipt) and CLI wiring.
// The real installation is never written to.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, report, tempDir, cleanup, assertThrows } from './helpers.mjs';
import {
  PATCHES, KNOWN_VERSION, transformAgent, apply, verify, rollback, checkState, backupPaths, loadReceipt, hash,
} from '../agent-telemetry-patch.mjs';

const root = tempDir('zcode-agent-apply-');

function syntheticText() {
  return [
    '"use strict";',
    'function a8t(e){return e.OTEL_EXPORTER_OTLP_ENDPOINT}',
    'function b_s(e){return["0","false"].includes(e)}',
    'async function a_s(e,t){return {owner:1}}',
    PATCHES[0].original,
    'a(H4n,"prepareModelTelemetryEnv");a(a_s,"createPreparedOwner");',
    '',
  ].join('\n');
}

function makeFile(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'zcode.cjs');
  fs.writeFileSync(file, syntheticText());
  return file;
}

function expectedFor(text) {
  const patched = transformAgent(text).text;
  return { ...KNOWN_VERSION, appVersion: 'fixture', size: Buffer.byteLength(text), originalSha256: hash(Buffer.from(text, 'utf8')), patchedSha256: hash(Buffer.from(patched, 'utf8')) };
}

try {
  // --- happy path ----------------------------------------------------------
  {
    const text = syntheticText();
    const file = makeFile('happy');
    const expected = expectedFor(text);
    check(checkState(file, { expected }).status === 'patchable', '初始状态：可打补丁', 'initial state: patchable');
    const applied = apply(file, { expected });
    check(applied.status === 'applied' && applied.patches.length === 1, 'apply 成功（1 条规格）', 'apply succeeds (one spec)');
    const v = verify(file, { expected });
    check(v.ok === true && v.status === 'applied', 'apply 后验证通过', 'verification passes after apply');
    check(apply(file, { expected }).status === 'already-applied', '重复 apply 幂等', 'repeat apply is idempotent');
    const receipt = loadReceipt(file);
    check(receipt && receipt.tool === 'agent-telemetry-patch.mjs' && receipt.before.sha256 === expected.originalSha256, '收据记录前后哈希', 'receipt records before/after hashes');
    check(fs.readFileSync(file, 'utf8').includes('telemetry-privacy:disabled'), '已补丁文件带禁用标记', 'patched file carries the disable marker');
    check(!fs.readFileSync(file, 'utf8').includes('!a8t(e)||b_s('), '已补丁文件不再含可绕过条件', 'patched file no longer contains the bypassable guard');
    const rolled = rollback(file);
    check(rolled.status === 'restored', 'rollback 成功', 'rollback succeeds');
    check(fs.readFileSync(file, 'utf8') === text, '回滚后文件逐字节还原', 'file is byte-identical after rollback');
    check(!fs.existsSync(backupPaths(file).receipt), '回滚后收据已清理', 'receipt removed after rollback');
  }

  // --- unknown SHA refused -------------------------------------------------
  {
    const text = syntheticText();
    const file = makeFile('unknown');
    const expected = expectedFor(text);
    const raw = fs.readFileSync(file);
    raw[10] ^= 0xff;
    fs.writeFileSync(file, raw);
    check(checkState(file, { expected }).status === 'unknown', '被篡改文件状态为 unknown', 'a tampered file reports unknown');
    assertThrows(() => apply(file, { expected }), /Unknown agent bundle SHA256/, 'unknown SHA must be refused');
    check(true, '未知签名被拒绝（不写入）', 'unknown signature is refused without writing');
  }

  // --- existing backup blocks apply ---------------------------------------
  {
    const text = syntheticText();
    const file = makeFile('backup-exists');
    const expected = expectedFor(text);
    fs.writeFileSync(backupPaths(file).receipt, '{}');
    assertThrows(() => apply(file, { expected }), /Backup exists/, 'existing backup must block apply');
    check(true, '已有备份时拒绝覆盖写入', 'apply refuses when a backup already exists');
  }

  // --- external change blocks rollback and fails verify -------------------
  {
    const text = syntheticText();
    const file = makeFile('tamper');
    const expected = expectedFor(text);
    apply(file, { expected });
    const raw = fs.readFileSync(file);
    raw[raw.length - 2] ^= 0xff;
    fs.writeFileSync(file, raw);
    const v = verify(file, { expected });
    check(v.ok === false && v.problems.length > 0, '外部改动后验证失败', 'verification fails after an external change');
    assertThrows(() => rollback(file), /refusing destructive rollback/, 'rollback must refuse after an external change');
    check(true, '外部改动时拒绝破坏性回滚', 'rollback refuses a destructive restore after an external change');
  }

  // --- interrupted partial write inside the region is recoverable ---------
  {
    const text = syntheticText();
    const file = makeFile('partial-write');
    const expected = expectedFor(text);
    apply(file, { expected });
    const receipt = loadReceipt(file);
    const raw = fs.readFileSync(file);
    // Corrupt a few bytes inside the patched region only.
    for (let i = receipt.region.offset + 5; i < receipt.region.offset + 20; i++) raw[i] = 0xff;
    fs.writeFileSync(file, raw);
    const rolled = rollback(file);
    check(rolled.status === 'restored', '区域内半截写入可被识别并恢复', 'a torn write inside the region is detected and restored');
    check(fs.readFileSync(file, 'utf8') === text, '区域内半截写入恢复后逐字节还原', 'the file is byte-identical after recovering a torn write');
  }

  // --- change outside the region blocks rollback --------------------------
  {
    const text = syntheticText();
    const file = makeFile('outside-change');
    const expected = expectedFor(text);
    apply(file, { expected });
    const receipt = loadReceipt(file);
    const raw = fs.readFileSync(file);
    const outside = receipt.region.offset > 4 ? 2 : raw.length - 2;
    raw[outside] ^= 0xff;
    fs.writeFileSync(file, raw);
    assertThrows(() => rollback(file), /outside the patched region/, 'a change outside the region must block rollback');
    check(true, '区域外改动时拒绝破坏性回滚', 'rollback refuses a destructive restore after an out-of-region change');
  }

  // --- corrupted backup ----------------------------------------------------
  {
    const text = syntheticText();
    const file = makeFile('bad-backup');
    const expected = expectedFor(text);
    apply(file, { expected });
    const backup = fs.readFileSync(backupPaths(file).file);
    backup[3] ^= 0xff;
    fs.writeFileSync(backupPaths(file).file, backup);
    assertThrows(() => rollback(file), /Backup integrity failure/, 'a corrupted backup must be refused');
    assertThrows(() => loadReceipt(file), /Backup integrity failure/, 'a corrupted backup must fail receipt validation');
    check(true, '备份损坏时拒绝回滚', 'rollback refuses a corrupted backup');
  }

  // --- receipt bound to another target ------------------------------------
  {
    const text = syntheticText();
    const file = makeFile('target-mismatch');
    const expected = expectedFor(text);
    apply(file, { expected });
    const receipt = JSON.parse(fs.readFileSync(backupPaths(file).receipt, 'utf8'));
    receipt.target = 'D:/elsewhere/zcode.cjs';
    fs.writeFileSync(backupPaths(file).receipt, JSON.stringify(receipt, null, 2));
    assertThrows(() => rollback(file), /different target/, 'a receipt for another target must be refused');
    check(true, '收据与目标不匹配时拒绝回滚', 'rollback refuses a receipt bound to another target');
  }

  // --- foreign / damaged receipt ------------------------------------------
  {
    const text = syntheticText();
    const file = makeFile('foreign-receipt');
    const expected = expectedFor(text);
    apply(file, { expected });
    const receipt = JSON.parse(fs.readFileSync(backupPaths(file).receipt, 'utf8'));
    receipt.tool = 'telemetry-patch.mjs';
    fs.writeFileSync(backupPaths(file).receipt, JSON.stringify(receipt, null, 2));
    assertThrows(() => rollback(file), /not written by agent-telemetry-patch/, 'a foreign receipt must be refused');
    fs.writeFileSync(backupPaths(file).receipt, '{"version":1,');
    assertThrows(() => rollback(file), /receipt is not valid JSON/, 'a damaged receipt must be refused with a clear error');
    check(true, '其他工具收据与损坏收据均被拒绝', 'foreign and damaged receipts are both refused');
  }

  // --- missing file --------------------------------------------------------
  {
    const file = path.join(root, 'no-such', 'zcode.cjs');
    const state = checkState(file);
    check(state.status === 'missing' && state.problems.length > 0, '缺失文件报告 missing', 'a missing file reports missing');
    assertThrows(() => apply(file), /找不到所需文件|Required file not found/, 'apply must error on a missing file');
    check(true, '缺失文件时明确报错', 'a missing file yields an explicit error');
  }

  // --- CLI wiring ----------------------------------------------------------
  {
    const { spawnSync } = await import('node:child_process');
    const cli = fileURLToPath(new URL('../agent-telemetry-patch.mjs', import.meta.url));
    const file = makeFile('cli');
    const checkRun = spawnSync(process.execPath, [cli, 'check', file], { encoding: 'utf8', cwd: root });
    check(checkRun.status === 1 && /未知签名|unknown/.test(checkRun.stdout), 'CLI check 对未知签名报告失败', 'CLI check reports failure for an unknown signature');
    const applyRun = spawnSync(process.execPath, [cli, 'apply', file], { encoding: 'utf8', cwd: root });
    check(applyRun.status === 1 && /--confirm/.test(applyRun.stdout), 'CLI apply 缺少 --confirm 时被拒绝', 'CLI apply without --confirm is rejected');
    const missingRun = spawnSync(process.execPath, [cli, 'check', path.join(root, 'no-such.asar')], { encoding: 'utf8', cwd: root });
    check(missingRun.status === 1 && /找不到所需文件|Required file not found/.test(missingRun.stdout), 'CLI 指向不存在文件时报错', 'CLI errors on a missing target');
  }
} catch (e) {
  check(false, 'Agent 端到端测试发生异常：' + e.message, 'agent end-to-end suite threw: ' + e.message);
}

cleanup(root);
report('Agent 遥测硬阻断补丁：端到端测试（合成文件，临时目录）', 'Agent telemetry hard-block patch: end-to-end tests (synthetic file, temp dir)', process);
