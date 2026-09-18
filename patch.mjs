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
      console.log('安装规则检查 / Installation rule check');
      console.log(`文件 / File: ${target}`);
      if (r.changed) {
        console.log('\n[待修复 / PATCHABLE] 本地规则仍包含多余的 reasoning.effort，尚未达到补丁目标状态。');
        console.log('The local rule still contains the extra reasoning.effort field.');
        console.log('状态 / Status: patchable');
        console.log('下一步：运行 make apply 或 npm run apply，然后再次检查。');
        console.log('Next: run make apply or npm run apply, then verify again.');
      } else {
        console.log('\n[规则已修复 / RULE FIXED] 本地通用规则已无嵌套 reasoning，reasoning_effort 仍保留，无需重复应用。');
        console.log('The local generic rule has no nested reasoning; reasoning_effort is preserved. No reapplication needed.');
        console.log('状态 / Status: no-nested-reasoning');
        console.log('当前进程可能缓存旧规则；方便时请自行重新加载 ZCode，再新建会话测试。');
        console.log('The running app may cache old rules. Reload ZCode when convenient, then test a new conversation.');
      }
      console.log('\n本次仅检查磁盘文件，未修改文件或操作进程，也未验证真实接口。');
      console.log('Read-only disk check: no file changes, process operations or live API verification.');
      console.log(`SHA256: ${hash(bytes)}`);
    } else if (['apply','rollback'].includes(command)) {
      if(consent!=='--confirm') throw Error('Explicit target and --confirm required');
      console.log(JSON.stringify(command==='apply'?apply(target):rollback(target),null,2));
    } else throw Error('Usage: node patch.mjs check|apply|rollback [target] [--confirm]');
  } catch(e) {
    console.error('[失败 / ERROR] 操作未完成 / Operation did not complete.');
    if (e.code === 'ENOENT') console.error('找不到所需文件，请检查安装路径或备份是否存在。 / Required file not found; check installation path or backup.');
    else if (['EACCES','EPERM'].includes(e.code)) console.error('权限不足，请检查文件访问权限。 / Permission denied; check file access permissions.');
    else console.error('文件内容、规则版本或备份状态未通过检查，请根据下方详情排查。 / File content, rule version or backup state failed validation; see details below.');
    console.error(`详情 / Details: ${e.message}`);
    process.exitCode=1;
  }
}
