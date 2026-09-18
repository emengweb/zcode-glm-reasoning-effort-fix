import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {transform,apply,rollback,hash,defaultTarget} from '../patch.mjs';
import {resolveRuleSource} from './rule-source.mjs';

// The installed rules may already carry the reasoning patch. Resolve an
// unpatched original from the verified backup (preferred) or a fixed fixture,
// and keep verifying that the installed file itself is unchanged.
const installedText=fs.readFileSync(defaultTarget,'utf8');
const installedHash=hash(fs.readFileSync(defaultTarget));
const ruleSource=resolveRuleSource(installedText);
const original=Buffer.from(ruleSource.originalText,'utf8');
const fixed=ruleSource.fixed;
assert.equal(fixed.changed,true);
console.log('PASS rule source:',ruleSource.mode,'('+ruleSource.reason+')');
if(ruleSource.mode==='fixture'&&ruleSource.backupIssues?.length){
  console.log('NOTE: original backup was not usable ('+ruleSource.backupIssues.join('; ')+'); using the fixed mapping fixture.');
}
if(ruleSource.mode==='backup'){
  assert.notEqual(installedHash,hash(original),'installed rules should differ from the unpatched backup');
}

// Evaluate only the locally installed (or verified-backup) mapping expression,
// never the complete Agent.
function evaluate(map,level){return vm.runInNewContext('('+map+')',{reasoningLevel:level},{timeout:100});}
for(const level of ['low','high','max','disabled','enabled','none']){
  const before=evaluate(fixed.before,level),after=evaluate(fixed.after,level);
  assert.ok(before.reasoning); assert.equal(after.reasoning,undefined);
  delete before.reasoning; assert.equal(JSON.stringify(before),JSON.stringify(after));
  console.log('PASS level:',level);
}

// Exercise the actual fetch wrapper extracted from the installed runtime, not
// the full executable. This always reads the real installation.
const runtimeSource=fs.readFileSync('C:/Program Files/ZCode/resources/glm/zcode.cjs','utf8');
const start=runtimeSource.indexOf('function Iqr(e){');const end=runtimeSource.indexOf('var Tqr=',start);
assert.ok(start>=0 && end>start);
const factory=vm.runInNewContext(runtimeSource.slice(start,end)+';Iqr',{Request,JSON,Error});
for(const requestObject of [false,true]){
 let captured;
 const wrapped=factory({maps:{apply:(body,values)=>({...body,...evaluate(fixed.after,values.reasoningLevel)})},values:{reasoningLevel:'max'},fetch:async(t,r)=>{captured=JSON.parse(t instanceof Request?await t.text():r.body);return {ok:true};}});
 const body=JSON.stringify({model:'glm-5.3-flash',messages:[],stream:true});
 await wrapped(requestObject?new Request('https://offline.invalid/v1/chat/completions',{method:'POST',body}):'https://offline.invalid/v1/chat/completions',requestObject?undefined:{method:'POST',body});
 assert.equal(captured.reasoning,undefined); assert.equal(captured.reasoning_effort,'max');assert.equal(captured.stream,true);
}
console.log('PASS installed fetch wrapper: string body and Request; mocked transport only');

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zcode-patch-test-'));const target=path.join(dir,'rules.json');
try{
 fs.writeFileSync(target,original);apply(target);assert.equal(transform(fs.readFileSync(target,'utf8')).changed,false);
 assert.equal(apply(target).status,'already-fixed');
 fs.appendFileSync(target,' ');assert.throws(()=>rollback(target),/changed since/);
 fs.writeFileSync(target,fixed.text);rollback(target);assert.equal(hash(fs.readFileSync(target)),hash(original));
 assert.throws(()=>transform('{}'),/schema/);
 assert.throws(()=>transform(ruleSource.originalText.replace('reasoning_effort','unexpected_field')),/Missing preserved/);
 console.log('PASS backup, idempotence, rollback integrity, concurrent-change refusal, signature/schema rejection');
}finally{fs.rmSync(dir,{recursive:true,force:true});}

assert.equal(hash(fs.readFileSync(defaultTarget)),installedHash);
console.log('PASS installed rules unchanged SHA256='+installedHash);
console.log('Runtime SHA256='+hash(Buffer.from(runtimeSource)));
console.log('NOTE: offline verification only, no live provider request.');
