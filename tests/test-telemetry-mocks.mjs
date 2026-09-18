// Suite 3: behaviour. Extracts the REAL functions from the installed bundle and
// proves with VM sandboxes and side-effect counters that:
//   - the original event-report transport performs a network POST while the
//     patched one performs none;
//   - the original renderer-action OTLP exporter is constructed (and would
//     POST) while the patched one is not;
//   - the real endpoint resolver returns an Aliyun URL for the original
//     packaged env and nothing for the patched (blanked) env;
//   - the real agent model-telemetry gate stays off with the blanked endpoint
//     or with ZCODE_MODEL_TELEMETRY_ENABLED=false;
//   - the real ARMS collector gate honours enable:false;
//   - the ordinary model path bytes are untouched.
//
// The real installation is opened read-only; nothing is executed from it.
import fs from 'node:fs';
import vm from 'node:vm';
import { check, skip, report, assert } from './helpers.mjs';
import {
  realEntryText, realGlmPath, extractFunction, extractObjectLiteral, validHttpUrl, changedRegions,
} from './telemetry-helpers.mjs';
import { KNOWN_VERSION, transformEntries, PATCHES } from '../telemetry-patch.mjs';

const ENTRIES = Object.keys(KNOWN_VERSION.entries);

function runFunction(text, sandbox) {
  const context = vm.createContext({
    AbortSignal,
    AbortController,
    setTimeout,
    clearTimeout,
    URL,
    ...sandbox,
  });
  return vm.runInContext('(' + text + ')', context, { filename: 'extracted-fn.js' });
}

function specFor(id) {
  const spec = PATCHES.find(p => p.id === id);
  if (!spec) throw Error('Unknown spec: ' + id);
  return spec;
}

let real = null;
try {
  if (!fs.existsSync(realGlmPath)) {
    skip('未找到真实安装的 glm/zcode.cjs，跳过行为验证', 'real glm/zcode.cjs absent; behaviour checks skipped');
  } else {
    const texts = {};
    for (const p of ENTRIES) texts[p] = realEntryText(p);
    real = { texts, patched: transformEntries(texts).texts };
    if (ENTRIES.some(p => !real.texts[p])) { real = null; skip('真实 ASAR 条目缺失，跳过行为验证', 'real ASAR entries missing; behaviour checks skipped'); }
  }

  if (real) {
    // --- event-report transport: original POSTs, patched is inert ----------
    {
      const original = extractFunction(real.texts['out/main/chunk-HW54O52P.js'], 'async function ie(T,V){');
      const patched = extractFunction(real.patched['out/main/chunk-HW54O52P.js'], 'async function ie(T,V){/*telemetry-privacy:disabled');
      const makeSandbox = counters => ({
        n: async () => { counters.net++; return { ok: true, status: 200 }; },
        g: 5000,
        fn: class extends Error { constructor(category, retryable, status) { super('telemetry'); this.category = category; this.retryable = retryable; this.status = status; } },
        E: () => new (class extends Error {})('http_other', false, 500),
      });
      const oc = { net: 0 };
      const originalFn = runFunction(original, makeSandbox(oc));
      await originalFn('https://zcode.z.ai/api/v1/event/report', '{"event_id":"x"}');
      check(oc.net === 1, '原始事件上报传输会发起一次 POST（网络副作用）', 'original event-report transport performs one network POST');
      const pc = { net: 0 };
      const patchedFn = runFunction(patched, makeSandbox(pc));
      const result = await patchedFn('https://zcode.z.ai/api/v1/event/report', '{"event_id":"x"}');
      check(pc.net === 0, '已补丁事件上报传输零网络副作用', 'patched event-report transport has zero network side effects');
      check(result === undefined, '已补丁传输立即返回', 'patched transport returns immediately');
      check(!/await|fetch|method:"POST"/.test(patched), '已补丁函数体不含网络调用逻辑', 'patched body contains no network-call logic');
      check(real.patched['out/main/chunk-HW54O52P.js'].includes('s(ie,"sendReportAttempt")'), '传输函数名绑定保持完整（模块结构未破坏）', 'the transport function binding is intact (module structure preserved)');
    }

    // --- renderer-action OTLP exporter ------------------------------------
    {
      const original = extractFunction(real.texts['out/main/index.js'], 'function Ww(e){let t=nD(e);');
      const patched = extractFunction(real.patched['out/main/index.js'], 'function Ww(e){let t=nD(e);if(0)');
      const makeSandbox = counters => ({
        nD: () => 'https://proj-xtrace.invalid/apm/trace/opentelemetry/v1/traces',
        rD: class { constructor(o) { counters.exporter++; this.options = o; } },
        oD: () => ({ 'x-arms-license-key': 'redacted' }),
      });
      const oc = { exporter: 0 };
      const originalFn = runFunction(original, makeSandbox(oc));
      const built = originalFn({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://proj-xtrace.invalid/apm/trace/opentelemetry' });
      check(oc.exporter === 1 && built, '原始代码会构造 OTLP trace 导出器（将上报）', 'original code constructs the OTLP trace exporter (would upload)');
      const pc = { exporter: 0 };
      const patchedFn = runFunction(patched, makeSandbox(pc));
      const none = patchedFn({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://proj-xtrace.invalid/apm/trace/opentelemetry' });
      check(pc.exporter === 0 && none === undefined, '已补丁代码不再构造导出器（零上报）', 'patched code never constructs the exporter (zero upload)');
      // Endpoint blanking alone is sufficient too.
      const pc2 = { exporter: 0 };
      const noEndpoint = runFunction(original, { ...makeSandbox(pc2), nD: () => undefined });
      check(noEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: '   ' }) === undefined && pc2.exporter === 0, '端点置空后即使原逻辑也不构造导出器', 'with a blank endpoint even the original logic builds no exporter');
    }

    // --- real endpoint resolver against the real packaged env -------------
    {
      const nD = extractFunction(real.texts['out/main/index.js'], 'function nD(e){let t=Mw(');
      const Mw = extractFunction(real.texts['out/main/index.js'], 'function Mw(e){let t=e?.trim();');
      const ctx = vm.createContext({ URL });
      vm.runInContext('var Mw = ' + Mw + '; var nD = ' + nD + ';', ctx);
      const originalEnv = extractObjectLiteral(real.texts['out/main/chunk-DBVOEQ2Z.js'], 'p');
      const patchedEnv = extractObjectLiteral(real.patched['out/main/chunk-DBVOEQ2Z.js'], 'p');
      const originalUrl = vm.runInContext('nD(env)', vm.createContext({ ...ctx, env: originalEnv }));
      const patchedUrl = vm.runInContext('nD(env)', vm.createContext({ ...ctx, env: patchedEnv }));
      check(typeof originalUrl === 'string' && originalUrl.includes('aliyuncs.com'), '原始打包环境解析出阿里云 OTLP 上报地址', 'original packaged env resolves to the Aliyun OTLP upload URL');
      check(patchedUrl === undefined, '已补丁打包环境解析不出任何上报地址', 'patched packaged env resolves to no upload URL at all');
      check(patchedEnv.OTEL_SERVICE_NAME === 'zcode-cli-agent' && patchedEnv.ZCODE_TELEMETRY_RUNTIME_DISTRIBUTION === 'packaged', '非上报字段保持不变', 'non-upload fields are unchanged');
    }

    // --- real agent model-telemetry gate ----------------------------------
    {
      const glm = fs.readFileSync(realGlmPath, 'utf8');
      const a8t = extractFunction(glm, 'function a8t(e){let t=e.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT');
      const b_s = extractFunction(glm, 'function b_s(e){return[');
      const H4n = extractFunction(glm, 'async function H4n(e,t={}){');
      const makeSandbox = counters => ({
        Kqe: validHttpUrl,
        URL,
        c8t: () => undefined,
        l_s: async () => undefined,
        a_s: () => { counters.init++; return Promise.resolve({ shutdown() {} }); },
        Pfe: undefined,
        Ofe: undefined,
      });
      const aliEnv = { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://proj-xtrace.invalid/apm/trace/opentelemetry' };
      const oc = { init: 0 };
      const c1 = vm.createContext(makeSandbox(oc));
      vm.runInContext('var a8t = ' + a8t + '; var b_s = ' + b_s + '; var H4n = ' + H4n + ';', c1);
      c1.env = aliEnv;
      const withEndpoint = await vm.runInContext('H4n(env)', c1);
      check(oc.init === 1 && withEndpoint === aliEnv, '原始环境会初始化模型遥测（端点存在）', 'original env initialises model telemetry (endpoint present)');
      const fc = { init: 0 };
      const c2 = vm.createContext(makeSandbox(fc));
      vm.runInContext('var a8t = ' + a8t + '; var b_s = ' + b_s + '; var H4n = ' + H4n + ';', c2);
      c2.env = { ...aliEnv, OTEL_EXPORTER_OTLP_ENDPOINT: '   ' };
      const blanked = await vm.runInContext('H4n(env)', c2);
      check(fc.init === 0, '端点置空后模型遥测不再初始化', 'a blank endpoint stops model telemetry initialisation');
      const c3 = vm.createContext(makeSandbox({ init: 0 }));
      vm.runInContext('var a8t = ' + a8t + '; var b_s = ' + b_s + '; var H4n = ' + H4n + ';', c3);
      c3.env = { ...aliEnv, ZCODE_MODEL_TELEMETRY_ENABLED: 'false' };
      const flagBlanked = await vm.runInContext('H4n(env)', c3);
      check((await vm.runInContext("b_s('false')", c3)) === true, 'ZCODE_MODEL_TELEMETRY_ENABLED=false 被真实开关识别', 'ZCODE_MODEL_TELEMETRY_ENABLED=false is honoured by the real switch');
      check(flagBlanked === c3.env, '开关关闭时返回原环境（不初始化遥测）', 'with the switch off the original env is returned (no telemetry init)');
      check(blanked !== undefined, '禁用后仍返回原环境（不影响模型请求）', 'disabling still returns the original env (model requests unaffected)');
    }

    // --- real ARMS collector gate -----------------------------------------
    {
      const sdk = realEntryText('node_modules/@arms/rum-electron/dist/index.mjs');
      const gate = extractFunction(sdk, 'function _(h,m,d){var u;d===void 0');
      const ctx = vm.createContext({ E: { isBoolean: x => typeof x === 'boolean', isObject: x => !!x && typeof x === 'object' } });
      vm.runInContext('var _ = ' + gate + ';', ctx);
      const disabled = vm.runInContext("_({getConfig:()=>({enable:!1})}, 'jsError')", ctx);
      const enabled = vm.runInContext("_({getConfig:()=>({enable:!0})}, 'jsError')", ctx);
      check(disabled === false && enabled === true, '真实 ARMS 采集开关在 enable:false 时关闭采集器', 'the real ARMS collector gate turns collectors off when enable:false');
      check(real.patched['out/main/index.js'].includes('mi.init({enable:!1'), '已补丁代码向真实 ARMS 传入 enable:false', 'patched code passes enable:false to the real ARMS init');
    }

    // --- ordinary model path bytes are untouched --------------------------
    {
      const specsByEntry = {};
      for (const spec of PATCHES) (specsByEntry[spec.entry] ||= []).push(spec);
      let ok = true;
      for (const entry of ENTRIES) {
        const ranges = specsByEntry[entry].map(s => {
          const buf = Buffer.from(real.texts[entry], 'utf8');
          const i = buf.indexOf(Buffer.from(s.original, 'utf8'));
          return { start: i, end: i + Buffer.byteLength(s.original) };
        });
        const regions = changedRegions(Buffer.from(real.texts[entry], 'utf8'), Buffer.from(real.patched[entry], 'utf8'));
        const outside = regions.filter(r => !ranges.some(range => r.start >= range.start && r.start + r.length <= range.end));
        if (outside.length) { ok = false; check(false, entry + ' 在遥测锚点之外发生改动', entry + ' changed outside the telemetry anchors'); }
      }
      check(ok, '补丁只改动遥测锚点，模型/功能代码逐字节不变', 'the patch only changes telemetry anchors; model/functional code is byte-identical');
    }
  }
} catch (e) {
  check(false, '行为测试发生异常：' + e.message, 'behaviour suite threw: ' + e.message);
}

report('遥测上报禁用补丁：真实提取函数 + mock 副作用测试（真实安装只读）', 'Telemetry-reporting patch: real extracted functions + mock side effects (real install read-only)', process);
