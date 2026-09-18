// Suite A1: Agent hard-block patch logic. Proves the single H4n replacement is
// byte-exact, length-preserving, idempotent and confined to that function, that
// the real bundle (read-only) matches the pinned signature, and that the
// surrounding telemetry functions (a8t / b_s / a_s) are untouched.
import fs from 'node:fs';
import { check, skip, report, tempDir, cleanup } from './helpers.mjs';
import { realGlmPath, extractFunction, changedRegions } from './telemetry-helpers.mjs';
import { PATCHES, KNOWN_VERSION, transformAgent, buildPatched, hash, defaultAgentFile } from '../agent-telemetry-patch.mjs';

const root = tempDir('zcode-agent-logic-');

function syntheticAgentText() {
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

try {
  // --- spec shape ----------------------------------------------------------
  check(PATCHES.length === 1, 'Agent 硬阻断只有 1 条规格（共用入口）', 'the Agent hard block is a single spec (shared entry)');
  const spec = PATCHES[0];
  check(spec.id === 'agent.modelTelemetry.prepareEnv', '规格指向 prepareModelTelemetryEnv(H4n)', 'the spec targets prepareModelTelemetryEnv (H4n)');
  check(Buffer.byteLength(spec.patched) === Buffer.byteLength(spec.original), '替换保持 UTF-8 字节长度不变', 'the replacement keeps its UTF-8 byte length');
  check(spec.patched.includes('telemetry-privacy:disabled'), '替换带禁用标记', 'the replacement carries the disable marker');
  check(spec.patched.startsWith('async function H4n(e,t={}){/*telemetry-privacy:disabled'), '替换只改写 H4n 函数体', 'the replacement only rewrites the H4n body');
  check(spec.patched.endsWith('return e}'), '替换后 H4n 恒返回原环境', 'the patched H4n always returns the original env');

  // --- synthetic transform + idempotency ----------------------------------
  const text = syntheticAgentText();
  const first = transformAgent(text);
  check(first.changed === true && first.applied.length === 1, '合成文本上应用规格', 'the spec applies on synthetic text');
  check(Buffer.byteLength(first.text) === Buffer.byteLength(text), '合成文本字节长度不变', 'synthetic text keeps its byte length');
  const second = transformAgent(first.text);
  check(second.changed === false && second.already.length === 1, '重复变换幂等', 'repeat transform is idempotent');

  // --- real bundle ---------------------------------------------------------
  if (!fs.existsSync(realGlmPath)) {
    skip('未找到真实 glm/zcode.cjs，跳过真实字节比对', 'real glm/zcode.cjs absent; real byte comparison skipped');
  } else {
    const real = fs.readFileSync(realGlmPath, 'utf8');
    const realSha = hash(Buffer.from(real, 'utf8'));
    check(realSha === KNOWN_VERSION.originalSha256, '真实 Agent 包 SHA256 与钉住签名一致', 'real agent bundle SHA256 matches the pinned signature');
    check(Buffer.byteLength(real) === KNOWN_VERSION.size, '真实 Agent 包大小与钉住签名一致', 'real agent bundle size matches the pinned signature');
    check(real.split(spec.original).length - 1 === 1, '原始 H4n 在真实包中各出现且仅出现一次', 'the original H4n occurs exactly once in the real bundle');

    const transformed = transformAgent(real);
    check(transformed.applied.length === 1, '真实包上应用规格', 'the spec applies on the real bundle');
    const patchedSha = hash(Buffer.from(transformed.text, 'utf8'));
    check(patchedSha === KNOWN_VERSION.patchedSha256, '真实包已补丁 SHA256 与钉住签名一致', 'patched real bundle SHA256 matches the pinned signature');
    check(Buffer.byteLength(transformed.text) === Buffer.byteLength(real), '真实包替换后字节长度不变', 'real bundle keeps its byte length');

    // Only the H4n range may change.
    const origBuf = Buffer.from(real, 'utf8');
    const start = origBuf.indexOf(Buffer.from(spec.original, 'utf8'));
    const range = { start, end: start + Buffer.byteLength(spec.original) };
    const regions = changedRegions(origBuf, Buffer.from(transformed.text, 'utf8'));
    const outside = regions.filter(r => !(r.start >= range.start && r.start + r.length <= range.end));
    check(outside.length === 0, '改动只落在 H4n 函数范围内', 'changes are confined to the H4n function range');

    // The shared init chain and helpers must be byte-identical.
    let helpersIntact = true;
    for (const marker of ['function a8t(e){', 'function b_s(e){', 'function a_s(e,t){', 'function e_s(e){', 'createOwnedAgentTelemetryRuntime', 'a(H4n,"prepareModelTelemetryEnv")', 'a(a_s,"createPreparedOwner")']) {
      if (!transformed.text.includes(marker)) { helpersIntact = false; check(false, '缺少功能标记：' + marker, 'missing functional marker: ' + marker); }
    }
    check(helpersIntact, 'a8t/b_s/a_s/运行时与注解标记在补丁后仍存在', 'a8t/b_s/a_s/runtime and annotation markers survive the patch');
    const a8tOrig = extractFunction(real, 'function a8t(e){');
    const a8tPatched = extractFunction(transformed.text, 'function a8t(e){');
    const bsOrig = extractFunction(real, 'function b_s(e){');
    const bsPatched = extractFunction(transformed.text, 'function b_s(e){');
    check(a8tOrig === a8tPatched && bsOrig === bsPatched, 'a8t 与 b_s 函数体逐字节未变', 'a8t and b_s bodies are byte-identical');
    check(!transformed.text.includes('!a8t(e)||b_s(e.ZCODE_MODEL_TELEMETRY_ENABLED)'), '原条件判断已不存在（不可被环境变量绕过）', 'the original env-dependent guard is gone (cannot be bypassed by env vars)');
  }
} catch (e) {
  check(false, 'Agent 逻辑测试发生异常：' + e.message, 'agent logic suite threw: ' + e.message);
}

cleanup(root);
report('Agent 遥测硬阻断补丁：逻辑与真实字节比对（真实安装只读）', 'Agent telemetry hard-block patch: logic and real-byte comparison (real install read-only)', process);
