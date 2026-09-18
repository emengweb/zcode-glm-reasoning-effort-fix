// Unit tests for tests/rule-source.mjs: the integration suite must pick the
// installed file, a verified original backup, or a fixed fixture, and must fall
// back safely whenever the backup or receipt does not check out.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { check, report, tempDir, cleanup, assert, assertEqual } from './helpers.mjs';
import { transform, hash } from '../patch.mjs';
import { resolveRuleSource, fixtureRulesText } from './rule-source.mjs';

const root = tempDir('zcode-rule-source-');

function writeBackup(dir, beforeText, afterText, options = {}) {
  const backupPath = path.join(dir, 'rules.json.reasoning-fix.bak');
  const receiptPath = path.join(dir, 'rules.json.reasoning-fix.receipt.json');
  const backupText = options.backupText ?? beforeText;
  const installedText = options.installedText ?? afterText;
  fs.writeFileSync(backupPath, backupText);
  fs.writeFileSync(
    receiptPath,
    JSON.stringify({ before: options.beforeHash ?? hash(Buffer.from(beforeText, 'utf8')), after: options.afterHash ?? hash(Buffer.from(afterText, 'utf8')) })
  );
  return { backupPath, receiptPath, installedText };
}

try {
  // Fixture itself must be a valid, unpatched input for patch.mjs.
  const fixtureText = fixtureRulesText();
  const fixtureFixed = transform(fixtureText);
  check(fixtureFixed.changed === true, '固定夹具是 transform 可识别的未打补丁输入', 'fixed fixture is a transform-recognized unpatched input');
  const afterValues = vm.runInNewContext('(' + fixtureFixed.after + ')', { reasoningLevel: 'max' });
  const beforeValues = vm.runInNewContext('(' + fixtureFixed.before + ')', { reasoningLevel: 'max' });
  check(afterValues.reasoning_effort === 'max' && afterValues.reasoning === undefined, '夹具 after 保留 reasoning_effort 且无嵌套 reasoning', 'fixture after keeps reasoning_effort and drops nested reasoning');
  check(beforeValues.reasoning !== undefined, '夹具 before 含嵌套 reasoning', 'fixture before contains nested reasoning');

  // 1) Installed rules are still unpatched -> use them directly.
  {
    const source = resolveRuleSource(fixtureText, { backupPath: path.join(root, 'missing.bak'), receiptPath: path.join(root, 'missing.json') });
    check(source.mode === 'installed' && source.originalText === fixtureText, '安装未打补丁时直接使用安装文件', 'unpatched install is used directly');
  }

  // 2) Verified backup reproduces the installed file -> use the backup.
  {
    const dir = path.join(root, 'verified');
    fs.mkdirSync(dir, { recursive: true });
    const patched = fixtureFixed.text;
    const { backupPath, receiptPath, installedText } = writeBackup(dir, fixtureText, patched);
    const source = resolveRuleSource(installedText, { backupPath, receiptPath });
    check(source.mode === 'backup', '受校验备份被优先采用', 'verified backup is preferred');
    check(source.originalText === fixtureText, '备份里的未打补丁原文被用作测试输入', 'unpatched text from the backup is used as test input');
    check(hash(Buffer.from(source.fixed.text, 'utf8')) === hash(Buffer.from(installedText, 'utf8')), '备份打补丁结果与安装文件逐字节一致', 'backup patch result is byte-identical to the installed file');
  }

  // 3) Backup hash does not match the receipt -> fixture fallback.
  {
    const dir = path.join(root, 'bad-hash');
    fs.mkdirSync(dir, { recursive: true });
    const patched = fixtureFixed.text;
    const { backupPath, receiptPath, installedText } = writeBackup(dir, fixtureText, patched, { beforeHash: 'f'.repeat(64) });
    const source = resolveRuleSource(installedText, { backupPath, receiptPath });
    check(source.mode === 'fixture' && source.backupIssues.join(' ').includes('SHA256'), '备份哈希与收据不符时回退固定夹具', 'mismatched backup hash falls back to the fixture');
  }

  // 4) Backup is itself patched -> fixture fallback.
  {
    const dir = path.join(root, 'patched-backup');
    fs.mkdirSync(dir, { recursive: true });
    const patched = fixtureFixed.text;
    const { backupPath, receiptPath, installedText } = writeBackup(dir, fixtureText, patched, { backupText: patched, beforeHash: hash(Buffer.from(patched, 'utf8')) });
    const source = resolveRuleSource(installedText, { backupPath, receiptPath });
    check(source.mode === 'fixture' && source.backupIssues.join(' ').includes('unpatched original'), '备份本身已打补丁时回退固定夹具', 'already-patched backup falls back to the fixture');
  }

  // 5) Installed file is not the receipt.after result -> fixture fallback.
  {
    const dir = path.join(root, 'wrong-installed');
    fs.mkdirSync(dir, { recursive: true });
    const patched = fixtureFixed.text;
    const { backupPath, receiptPath } = writeBackup(dir, fixtureText, patched);
    const source = resolveRuleSource(patched + '\n', { backupPath, receiptPath });
    check(source.mode === 'fixture' && source.backupIssues.join(' ').includes('receipt.after'), '安装文件与收据结果不符时回退固定夹具', 'installed file differing from receipt.after falls back to the fixture');
  }

  // 6) Backup missing -> fixture fallback, and the fixture still works.
  {
    const dir = path.join(root, 'no-backup');
    fs.mkdirSync(dir, { recursive: true });
    const source = resolveRuleSource(fixtureFixed.text, { backupPath: path.join(dir, 'nope.bak'), receiptPath: path.join(dir, 'nope.json') });
    check(source.mode === 'fixture' && source.backupIssues.length > 0, '备份缺失时回退固定夹具并记录原因', 'missing backup falls back to the fixture and records the reason');
    check(transform(source.originalText).changed === true, '回退夹具仍可用于 apply/rollback 测试', 'fallback fixture still works for apply/rollback tests');
  }
} catch (e) {
  check(false, '规则来源解析测试发生异常：' + e.message, 'rule-source suite threw: ' + e.message);
}

cleanup(root);
report('规则来源解析测试（优先受校验备份，回退固定夹具）', 'Rule source resolution tests (verified backup first, fixture fallback)', process);
