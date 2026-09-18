// Suite A2: Agent hard-block behaviour. Extracts the REAL H4n
// ("prepareModelTelemetryEnv") from the installed agent bundle and proves, with
// a VM sandbox, that the patched entry performs NO telemetry initialisation
// even when an OTLP endpoint is present and ZCODE_MODEL_TELEMETRY_ENABLED is
// "true"/"1" (the exact conditions that defeat env-based blanking).
//
// The real installation is opened read-only; nothing is executed from it.
import fs from 'node:fs';
import vm from 'node:vm';
import { check, skip, report } from './helpers.mjs';
import { realGlmPath, extractFunction, validHttpUrl } from './telemetry-helpers.mjs';
import { PATCHES, transformAgent, KNOWN_VERSION, countOccurrences } from '../agent-telemetry-patch.mjs';

const spec = PATCHES[0];
const VALID_ENDPOINT = 'https://proj-xtrace.example.invalid/apm/trace/opentelemetry';

function runH4n(text, sandbox) {
  const context = vm.createContext({ URL, Promise, ...sandbox });
  vm.runInContext('var H4n = ' + text + ';', context);
  return { context, call: env => { context.env = env; return vm.runInContext('H4n(env)', context); } };
}

function makeSandbox(counters, { endpointValid = true } = {}) {
  return {
    a8t: () => (endpointValid ? 'https://proj-xtrace.example.invalid/apm/trace/opentelemetry/v1/traces' : undefined),
    b_s: e => ['0', 'false', 'off', 'disabled'].includes((e ?? '').trim().toLowerCase()),
    c8t: () => undefined,
    l_s: async () => undefined,
    a_s: () => { counters.init++; return Promise.resolve({ shutdown() {} }); },
    Pfe: undefined,
    Ofe: undefined,
  };
}

try {
  if (!fs.existsSync(realGlmPath)) {
    skip('未找到真实 glm/zcode.cjs，跳过硬阻断行为验证', 'real glm/zcode.cjs absent; hard-block behaviour checks skipped');
  } else {
    const real = fs.readFileSync(realGlmPath, 'utf8');
    check(countOccurrences(real, spec.original) === 1, '真实 H4n 锚点唯一', 'the real H4n anchor is unique');
    const original = extractFunction(real, 'async function H4n(e,t={}){');
    const patchedText = transformAgent(real).text;
    const patched = extractFunction(patchedText, 'async function H4n(e,t={}){/*telemetry-privacy:disabled');
    check(patched !== original && patched.includes('return e'), '已补丁 H4n 与原函数不同且立即返回', 'the patched H4n differs and returns immediately');

    // The exact bypass conditions: valid OTLP endpoint AND the switch enabled.
    const enabledEnv = { OTEL_EXPORTER_OTLP_ENDPOINT: VALID_ENDPOINT, ZCODE_MODEL_TELEMETRY_ENABLED: 'true' };

    const oc = { init: 0 };
    const o = runH4n(original, makeSandbox(oc));
    const oResult = await o.call({ ...enabledEnv });
    check(oc.init === 1, '原始 H4n 在有效端点 + 开关 true 下会初始化遥测（触发点证实）', 'original H4n initialises telemetry with a valid endpoint and the switch on (trigger confirmed)');
    check(oResult !== enabledEnv, '原始 H4n 返回派生的遥测环境', 'original H4n returns a derived telemetry env');

    for (const flag of ['true', '1', 'on', undefined]) {
      const pc = { init: 0 };
      const p = runH4n(patched, makeSandbox(pc));
      const env = { OTEL_EXPORTER_OTLP_ENDPOINT: VALID_ENDPOINT, ...(flag === undefined ? {} : { ZCODE_MODEL_TELEMETRY_ENABLED: flag }) };
      const result = await p.call(env);
      check(pc.init === 0, '已补丁 H4n 在有效端点 + 开关 ' + String(flag) + ' 下仍不初始化遥测', 'patched H4n never initialises telemetry with a valid endpoint and switch ' + String(flag));
      check(result === env, '已补丁 H4n 原样返回环境（模型请求不受影响）', 'patched H4n returns the env unchanged (model requests unaffected)');
    }

    // Even with the endpoint and switch, the shared owner a_s is never called.
    check(!patchedText.includes('a_s(o,t)'), '已补丁包中不再存在 a_s 调用点', 'the patched bundle no longer contains the a_s call site');
    const callSites = countOccurrences(real, 'a_s(o,t)');
    check(callSites === 1, '原始包中 a_s 仅由 H4n 调用（共用入口唯一）', 'in the original bundle a_s is called only by H4n (single shared entry)');
    check(!patchedText.includes('!a8t(e)||b_s(e.ZCODE_MODEL_TELEMETRY_ENABLED)'), '已补丁包不再包含可被环境变量绕过的条件', 'the patched bundle no longer contains the env-bypassable condition');
    check(patchedText.includes('a(H4n,"prepareModelTelemetryEnv")'), '函数注解保持完整（模块结构未破坏）', 'the function annotation is intact (module structure preserved)');
  }
} catch (e) {
  check(false, 'Agent 硬阻断行为测试发生异常：' + e.message, 'agent hard-block behaviour suite threw: ' + e.message);
}

report('Agent 遥测硬阻断：真实提取函数 + mock 证明有效端点/开关下零初始化（真实安装只读）', 'Agent telemetry hard block: real extracted function + mocks prove zero init with a valid endpoint/switch (real install read-only)', process);
