import assert from 'node:assert/strict';
import { transform } from '../patch.mjs';
const base = {config:{modelConfigRules:{modelApiRules:[
  {modelMatch:'.*',apiTypeMatch:'openai-chat-completions',config:{optionSpecs:{reasoningLevel:{map:'{\n  "thinking": {\n    "type": reasoningLevel == "disabled" || reasoningLevel == "none" ? "disabled" : "enabled"\n  },\n  "enable_thinking": reasoningLevel != "disabled" && reasoningLevel != "none",\n  "reasoning_effort": reasoningLevel == "disabled" ? "none" : reasoningLevel == "enabled" ? "high" : reasoningLevel,\n  "reasoning": {\n    "effort": reasoningLevel == "disabled" ? "none" : reasoningLevel == "enabled" ? "high" : reasoningLevel\n  }\n}'}}}},
  {modelMatch:'.*',apiTypeMatch:'openai-responses',config:{optionSpecs:{reasoningLevel:{map:'{\n  "reasoning": {\n    "effort": reasoningLevel\n  }\n}'}}}}
]}}};
const out=transform(JSON.stringify(base)); assert.equal(out.changed,true);
const chat=out.after; assert.match(chat,/reasoning_effort/); assert.doesNotMatch(chat,/'reasoning':|"reasoning":/);
const after=JSON.parse(out.text); assert.match(after.config.modelConfigRules.modelApiRules[1].config.optionSpecs.reasoningLevel.map,/reasoning/);
const second=transform(out.text); assert.equal(second.changed,false);
console.log('PASS: chat mapping removes only nested reasoning.effort; Responses mapping remains intact; idempotent.');
