import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
export const defaultTarget = 'C:/Program Files/ZCode/resources/config/provider/zcode-builtin.json';
export const hash = b => crypto.createHash('sha256').update(b).digest('hex');
export function transform(text) {
  const doc = JSON.parse(text);
  const rules = doc.config?.modelConfigRules?.modelApiRules;
  if (!Array.isArray(rules)) throw Error('Unsupported rule schema');
  const matches = rules.filter(r => r.modelMatch === '.*' && r.apiTypeMatch === 'openai-chat-completions');
  if (matches.length !== 1) throw Error('Expected exactly one generic Chat rule');
  const map = matches[0].config?.optionSpecs?.reasoningLevel?.map;
  if (typeof map !== 'string') throw Error('Missing mapping');
  const fragment = ',\n  "reasoning": {\n    "effort": reasoningLevel == "disabled" ? "none" : reasoningLevel == "enabled" ? "high" : reasoningLevel\n  }';
  if (!map.includes('"reasoning_effort"')) throw Error('Missing preserved effort field');
  if (!map.includes('"reasoning"')) return {text, changed:false, before:map, after:map};
  if (map.split(fragment).length !== 2) throw Error('Unknown mapping signature: refusing modification');
  const after = map.replace(fragment, '');
  const needle = JSON.stringify(map);
  if (text.split(needle).length !== 2) throw Error('Ambiguous serialized mapping');
  const result = text.replace(needle, JSON.stringify(after));
  JSON.parse(result);
  return {text:result, changed:true, before:map, after};
}
export function apply(target) {
  const original = fs.readFileSync(target);
  const result = transform(original.toString('utf8'));
  if (!result.changed) return {status:'already-fixed', target};
  const backup = target + '.reasoning-fix.bak';
  const receipt = target + '.reasoning-fix.receipt.json';
  if (fs.existsSync(backup) || fs.existsSync(receipt)) throw Error('Backup exists: inspect or rollback first');
  fs.writeFileSync(backup, original, {flag:'wx'});
  const patched = Buffer.from(result.text);
  fs.writeFileSync(receipt, JSON.stringify({before:hash(original), after:hash(patched)},null,2),{flag:'wx'});
  if (hash(fs.readFileSync(target)) !== hash(original)) throw Error('Target changed concurrently; refusing write');
  fs.writeFileSync(target, patched);
  if (hash(fs.readFileSync(target)) !== hash(patched)) throw Error('Post-write verification failed; backup retained');
  return {status:'applied',target,backup};
}
export function rollback(target) {
  const backup = target + '.reasoning-fix.bak';
  const receipt = target + '.reasoning-fix.receipt.json';
  const r = JSON.parse(fs.readFileSync(receipt,'utf8'));
  const original = fs.readFileSync(backup);
  if (hash(original) !== r.before) throw Error('Backup integrity failure');
  const current = hash(fs.readFileSync(target));
  if (current !== r.after && current !== r.before) throw Error('Target changed since patch; refusing destructive rollback');
  fs.writeFileSync(target,original);
  if(hash(fs.readFileSync(target))!==r.before) throw Error('Rollback verification failed');
  fs.unlinkSync(receipt); fs.unlinkSync(backup);
  return {status:'restored',target};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command='check', target=defaultTarget, consent] = process.argv.slice(2);
    if (command === 'check') {
      const bytes=fs.readFileSync(target); const r=transform(bytes.toString('utf8'));
      const zh = [], en = [];
      zh.push('安装规则检查', `文件：${target}`);
      en.push('Installation rule check', `File: ${target}`);
      if (r.changed) {
        zh.push('状态：待修复（patchable）', '本地规则仍包含多余的 reasoning.effort。', '下一步：运行 make apply，然后运行 make verify。');
        en.push('Status: PATCHABLE', 'The local rule still contains the extra reasoning.effort field.', 'Next: run make apply, then make verify.');
      } else {
        zh.push('状态：规则已修复（no-nested-reasoning）', '多余的嵌套 reasoning 已移除，reasoning_effort 仍保留，无需重复应用。', '当前进程可能缓存旧规则；方便时请自行重新加载 ZCode，再新建会话测试。');
        en.push('Status: RULE FIXED (no-nested-reasoning)', 'Nested reasoning is absent; reasoning_effort is preserved. No reapplication needed.', 'The running app may cache old rules. Reload ZCode when convenient, then test a new conversation.');
      }
      zh.push('本次仅检查磁盘文件，未修改文件、操作进程或验证真实接口。');
      en.push('Read-only disk check: no file changes, process operations or live API verification.');
      console.log(zh.join('\n') + '\n\n--- English ---\n' + en.join('\n') + `\n\nSHA256: ${hash(bytes)}`);

    } else if (['apply','rollback'].includes(command)) {
      if(consent!=='--confirm') throw Error('Explicit target and --confirm required');
      const result = command==='apply'?apply(target):rollback(target);
      const messages = {
        applied: ['补丁已写入，原文件已备份。请运行 make verify 检查结果。', 'Patch applied and original backed up. Run make verify to check.'],
        'already-fixed': ['规则已经修复，无需重复应用。', 'The rule is already fixed; no reapplication needed.'],
        restored: ['原文件已恢复，补丁已撤销。', 'Original file restored; patch rolled back.'],
      };
      const [zh,en] = messages[result.status];
      console.log(`操作完成\n${zh}\n文件：${target}\n本次没有关闭或重启 ZCode。\n\n--- English ---\nOperation completed\n${en}\nFile: ${target}\nZCode was not closed or restarted.`);
      if (result.backup) console.log(`\nBackup: ${result.backup}`);
    } else throw Error('Usage: node patch.mjs check|apply|rollback [target] [--confirm]');
  } catch(e) {
    let zh, en;
    if (e.code === 'ENOENT') {
      zh = '找不到所需文件，请检查安装路径或备份是否存在。';
      en = 'Required file not found. Check the installation path or backup.';
    } else if (['EACCES','EPERM'].includes(e.code)) {
      zh = '文件访问被拒绝。修改 Program Files 通常需要管理员权限，请在管理员 PowerShell 中重试。\n无需为此关闭 ZCode；若仍失败，请检查目录权限或安全软件拦截。';
      en = 'File access denied. Writing to Program Files usually requires an administrator PowerShell.\nYou do not need to close ZCode for this. If it persists, check directory permissions or security software.';
    } else {
      zh = '文件内容、规则版本或备份状态未通过检查，请根据下方详情排查。';
      en = 'File content, rule version or backup state failed validation. See details below.';
    }
    console.error(`操作失败\n${zh}\n\n--- English ---\nOperation failed\n${en}\n\n--- Details ---\n${e.message}`);
    process.exitCode=1;
  }
}
