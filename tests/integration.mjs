import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {transform,apply,rollback,hash,defaultTarget} from '../patch.mjs';
const original=fs.readFileSync(defaultTarget); const fixed=transform(original.toString('utf8'));
assert.equal(fixed.changed,true);
// Evaluate only the locally installed, inspected mapping expression, never the complete Agent.
function evaluate(map,level){return vm.runInNewContext('('+map+')',{reasoningLevel:level},{timeout:100});}
for(const level of ['low','high','max','disabled','enabled','none']){
  const before=evaluate(fixed.before,level),after=evaluate(fixed.after,level);
  assert.ok(before.reasoning); assert.equal(after.reasoning,undefined);
  delete before.reasoning; assert.equal(JSON.stringify(before),JSON.stringify(after));
  console.log('PASS level:',level);
}
// Exercise the actual fetch wrapper extracted from the installed runtime, not the full executable.
const source=fs.readFileSync('C:/Program Files/ZCode/resources/glm/zcode.cjs','utf8');
const start=source.indexOf('function Iqr(e){');const end=source.indexOf('var Tqr=',start);
assert.ok(start>=0 && end>start);
const factory=vm.runInNewContext(source.slice(start,end)+';Iqr',{Request,JSON,Error});
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
 assert.throws(()=>transform(original.toString('utf8').replace('reasoning_effort','unexpected_field')),/Missing preserved/);
 console.log('PASS backup, idempotence, rollback integrity, concurrent-change refusal, signature/schema rejection');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
assert.equal(hash(fs.readFileSync(defaultTarget)),hash(original));
console.log('PASS installed rules unchanged SHA256='+hash(original));
console.log('Runtime SHA256='+hash(Buffer.from(source)));
console.log('NOTE: offline verification only, no live provider request.');
