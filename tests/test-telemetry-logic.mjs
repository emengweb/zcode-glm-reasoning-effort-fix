// Suite 1: patch logic. Proves the specs are byte-exact, length-preserving and
// idempotent, that they only touch the intended regions, and that the real
// installation (read-only) matches the pinned version signature.
import fs from 'node:fs';
import path from 'node:path';
import { check, skip, report, tempDir, cleanup, assert, assertEqual } from './helpers.mjs';
import { buildTelemetryFixture } from './fixture-telemetry-asar.mjs';
import { realEntryText, changedRegions } from './telemetry-helpers.mjs';
import {
  PATCHES, KNOWN_VERSION, transformEntries, blankJsonString, hash, defaultAsar, readAsarHeader,
  crashReporterAssessment,
} from '../telemetry-patch.mjs';

const root = tempDir('zcode-tel-logic-');
const TARGET_ENTRIES = Object.keys(KNOWN_VERSION.entries);

try {
  // --- spec shape ----------------------------------------------------------
  check(PATCHES.length === 6, '共 6 条补丁规格', 'six patch specs are defined');
  const ids = new Set(PATCHES.map(p => p.id));
  check(ids.size === PATCHES.length, '补丁 id 唯一', 'patch ids are unique');
  let allLengthPreserving = true;
  for (const spec of PATCHES) {
    if (Buffer.byteLength(spec.patched) !== Buffer.byteLength(spec.original)) allLengthPreserving = false;
  }
  check(allLengthPreserving, '所有替换保持 UTF-8 字节长度不变', 'every replacement keeps its UTF-8 byte length');

  // --- blanked JSON literals ----------------------------------------------
  const blankSpecs = PATCHES.filter(p => p.blank);
  check(blankSpecs.length === 3, '3 条规格将遥测 URL/密钥字面量置空', 'three specs blank telemetry URL/secret literals');
  check(blankSpecs.every(s => s.patched.replace(/"/g, '').trim() === ''), '置空后的字面量 trim 后为空', 'blanked literals trim to empty');
  check(blankJsonString('"abc"') === '"   "', 'blankJsonString 生成等长空白字面量', 'blankJsonString produces an equal-length whitespace literal');

  // --- fixture transform + idempotency ------------------------------------
  const f = buildTelemetryFixture(path.join(root, 'fixture'));
  const texts = {};
  for (const p of TARGET_ENTRIES) texts[p] = f.byPath[p].buffer.toString('utf8');
  const first = transformEntries(texts);
  check(first.applied.length === 6 && first.already.length === 0, '夹具上应用全部 6 条规格', 'all six specs apply on the fixture');
  check(first.changed === true, '夹具文本确实发生变化', 'fixture text actually changes');
  const second = transformEntries(first.texts);
  check(second.applied.length === 0 && second.already.length === 6, '重复变换幂等（全部已打补丁）', 'repeat transform is idempotent (all already patched)');
  for (const p of TARGET_ENTRIES) {
    check(Buffer.byteLength(first.texts[p]) === Buffer.byteLength(texts[p]), p + ' 变换后字节长度不变', p + ' keeps its byte length after transform');
  }

  // --- real installation: byte-exact anchors and pinned hashes ------------
  const realTexts = {};
  let realAvailable = fs.existsSync(defaultAsar);
  if (realAvailable) {
    for (const p of TARGET_ENTRIES) {
      const text = realEntryText(p);
      if (!text) { realAvailable = false; break; }
      realTexts[p] = text;
    }
  }
  if (!realAvailable) {
    skip('未找到真实安装，跳过真实字节比对（仅验证夹具逻辑）', 'real installation absent; real byte comparison skipped (fixture logic only)');
  } else {
    const meta = readAsarHeader(defaultAsar);
    fs.closeSync(meta.fd);
    check(meta.dataStart === KNOWN_VERSION.dataStart && meta.jsonLen === KNOWN_VERSION.jsonLen, '真实 ASAR 头部几何与版本签名一致', 'real ASAR header geometry matches the pinned signature');
    let anchorsExact = true;
    for (const spec of PATCHES) {
      const occurrences = realTexts[spec.entry].split(spec.original).length - 1;
      if (occurrences !== 1) { anchorsExact = false; check(false, spec.id + ' 在真实文件中出现 ' + occurrences + ' 次', spec.id + ' occurs ' + occurrences + ' time(s) in the real bundle'); }
    }
    check(anchorsExact, '全部原始锚点在真实文件中各出现且仅出现一次', 'every original anchor occurs exactly once in the real bundle');

    const realTransformed = transformEntries(realTexts);
    check(realTransformed.applied.length === 6, '真实文件上应用全部 6 条规格', 'all six specs apply on the real bundle');
    let shasOk = true;
    for (const p of TARGET_ENTRIES) {
      const pinned = KNOWN_VERSION.entries[p];
      if (hash(Buffer.from(realTexts[p], 'utf8')) !== pinned.originalSha256) { shasOk = false; check(false, p + ' 原始 SHA256 与钉住值不一致', p + ' original SHA256 does not match the pinned value'); }
      if (hash(Buffer.from(realTransformed.texts[p], 'utf8')) !== pinned.patchedSha256) { shasOk = false; check(false, p + ' 已补丁 SHA256 与钉住值不一致', p + ' patched SHA256 does not match the pinned value'); }
    }
    check(shasOk, '真实条目原始/已补丁 SHA256 均与钉住签名一致', 'real entries match the pinned original and patched SHA256 values');

    // Only the intended byte ranges may change: every changed byte must fall
    // inside a spec's original range, and each range must actually change.
    const specRanges = entry => PATCHES
      .filter(s => s.entry === entry)
      .map(s => {
        const buf = Buffer.from(realTexts[entry], 'utf8');
        const i = buf.indexOf(Buffer.from(s.original, 'utf8'));
        return { start: i, end: i + Buffer.byteLength(s.original) };
      });
    let regionsOk = true;
    for (const p of TARGET_ENTRIES) {
      const regions = changedRegions(Buffer.from(realTexts[p], 'utf8'), Buffer.from(realTransformed.texts[p], 'utf8'));
      const ranges = specRanges(p);
      const outside = regions.filter(r => !ranges.some(range => r.start >= range.start && r.start + r.length <= range.end));
      if (outside.length) { regionsOk = false; check(false, p + ' 在预期范围之外发生改动：' + JSON.stringify(outside), p + ' changed outside the intended ranges: ' + JSON.stringify(outside)); }
      for (const range of ranges) {
        if (!regions.some(r => r.start >= range.start && r.start < range.end)) { regionsOk = false; check(false, p + ' 预期范围未被改动', p + ' an intended range did not change'); }
      }
    }
    check(regionsOk, '每个条目只改动了预期的字节区域', 'each entry only changes the intended byte regions');

    // The ordinary model/provider path must remain byte-identical.
    const modelMarkers = {
      'out/main/index.js': ['resolveZCodeEndpointOrigin', 'zcode-plan', 'spawnHostProcess', 'function nD(e){let t=Mw(', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'],
      'out/main/chunk-HW54O52P.js': ['s(F8,"createTelemetryCore")', 'event_id:J,client_timezone', 'https://zcode.z.ai/api/v1/event/report'],
      'out/main/chunk-6XM33EZR.js': ['mapZCodeEnvToArmsRumEnv', 'normalizeZCodeEnv'],
      'out/main/chunk-DBVOEQ2Z.js': ['OTEL_SERVICE_NAME:"zcode-cli-agent"'],
    };
    let modelIntact = true;
    for (const [entry, markers] of Object.entries(modelMarkers)) {
      for (const marker of markers) {
        if (!realTransformed.texts[entry].includes(marker)) { modelIntact = false; check(false, entry + ' 缺失模型/功能标记：' + marker, entry + ' is missing functional marker: ' + marker); }
      }
    }
    check(modelIntact, '模型请求与功能标记在补丁后仍然存在', 'model-request and functional markers survive the patch');

    // The telemetry URLs must be gone; the endpoint constant itself stays (so
    // the SDK config shape is unchanged) but is blank.
    check(!realTransformed.texts['out/main/chunk-6XM33EZR.js'].includes('rum/web/v2?workspace='), 'ARMS RUM 上报地址已被置空', 'ARMS RUM upload URL is blanked');
    check(!realTransformed.texts['out/main/chunk-DBVOEQ2Z.js'].includes('apm/trace/opentelemetry'), 'OTLP trace 上报地址已被置空', 'OTLP trace upload URL is blanked');
    check(!realTransformed.texts['out/main/chunk-DBVOEQ2Z.js'].includes('x-arms-license-key='), 'OTLP 上报密钥已被置空', 'OTLP upload license key is blanked');
    check(realTransformed.texts['out/main/index.js'].includes('mi.init({enable:!1'), 'ARMS RUM 初始化改为 enable:false', 'ARMS RUM init is switched to enable:false');
    check(realTransformed.texts['out/main/chunk-HW54O52P.js'].includes('async function ie(T,V){/*telemetry-privacy:disabled'), '事件上报传输函数带禁用标记', 'event-report transport carries the disable marker');

    // Read-only fail-closed crash check on the real bundle.
    const crash = crashReporterAssessment(realTexts['out/main/index.js']);
    check(crash.ok === true && crash.submitUrl === 'https://zcode.invalid/local-crash-only', '真实崩溃上报为本地 only（只读 fail-closed 检查通过）', 'the real crash reporter is local-only (read-only fail-closed check passes)');
  }
} catch (e) {
  check(false, '补丁逻辑测试发生异常：' + e.message, 'logic suite threw: ' + e.message);
}

cleanup(root);
report('遥测上报禁用补丁：逻辑与真实字节比对（真实安装只读）', 'Telemetry-reporting patch: logic and real-byte comparison (real install read-only)', process);
