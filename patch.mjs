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
      console.log(JSON.stringify({target,sha256:hash(bytes),status:r.changed?'patchable':'no-nested-reasoning',before:r.before,after:r.after},null,2));
    } else if (['apply','rollback'].includes(command)) {
      if(consent!=='--confirm') throw Error('Explicit target and --confirm required');
      console.log(JSON.stringify(command==='apply'?apply(target):rollback(target),null,2));
    } else throw Error('Usage: node patch.mjs check|apply|rollback [target] [--confirm]');
  } catch(e) {console.error(e.message);process.exitCode=1;}
}
