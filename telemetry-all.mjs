// Combined telemetry-privacy patch driver.
//
// `npm run telemetry:apply` / `telemetry:verify` must cover BOTH surfaces in one
// command so the CLI bundle cannot be forgotten:
//
//   1. app.asar        (out/main/*)            -> telemetry-patch.mjs
//   2. glm/zcode.cjs   (Agent model telemetry) -> agent-telemetry-patch.mjs
//
// Each surface is attempted independently and reported separately. A failure on
// one surface is reported per item and makes the command exit non-zero; backups
// already written by the other surface are never removed.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ASAR from './telemetry-patch.mjs';
import * as AGENT from './agent-telemetry-patch.mjs';

export const defaultAsarPath = ASAR.defaultAsar;
export const defaultAgentPath = AGENT.defaultAgentFile;

function surfaceError(surface, e) {
  return { surface, status: 'error', ok: false, error: e.message };
}

export function checkAll(options = {}) {
  const asarPath = options.asarPath ?? defaultAsarPath;
  const agentPath = options.agentPath ?? defaultAgentPath;
  let asar;
  let agent;
  try {
    const state = ASAR.checkState(asarPath, options);
    asar = {
      surface: 'asar',
      path: asarPath,
      status: state.status,
      ok: (state.status === 'patchable' || state.status === 'applied') && state.problems.length === 0 && state.crash.ok,
      problems: state.problems,
      crash: state.crash,
    };
  } catch (e) {
    asar = surfaceError('asar', e);
  }
  try {
    const state = AGENT.checkState(agentPath, options);
    agent = {
      surface: 'agent',
      path: agentPath,
      status: state.status,
      ok: state.status === 'patchable' || state.status === 'applied',
      problems: state.problems,
    };
  } catch (e) {
    agent = surfaceError('agent', e);
  }
  const warnings = [];
  if (asar.ok && agent.ok && asar.status !== agent.status) {
    warnings.push(
      asar.status === 'applied'
        ? '部分安装：ASAR 面已打补丁，CLI 面尚未打补丁；请对两个面都执行 apply。'
        : '部分安装：CLI 面已打补丁，ASAR 面尚未打补丁；请对两个面都执行 apply。'
    );
  }
  return { ok: !!(asar.ok && agent.ok), warnings, asar, agent };
}

export function verifyAll(options = {}) {
  const asarPath = options.asarPath ?? defaultAsarPath;
  const agentPath = options.agentPath ?? defaultAgentPath;
  let asar;
  let agent;
  try {
    const result = ASAR.verify(asarPath, options);
    asar = { surface: 'asar', path: asarPath, status: result.status, ok: result.ok, problems: result.problems, crash: result.crash };
  } catch (e) {
    asar = surfaceError('asar', e);
  }
  try {
    const result = AGENT.verify(agentPath, options);
    agent = { surface: 'agent', path: agentPath, status: result.status, ok: result.ok, problems: result.problems };
  } catch (e) {
    agent = surfaceError('agent', e);
  }
  return { ok: !!(asar.ok && agent.ok), asar, agent };
}

export function applyAll(options = {}) {
  const asarPath = options.asarPath ?? defaultAsarPath;
  const agentPath = options.agentPath ?? defaultAgentPath;
  let asar;
  let agent;
  try {
    const result = ASAR.apply(asarPath, options);
    asar = { surface: 'asar', path: asarPath, status: result.status, ok: true, patches: result.patches };
  } catch (e) {
    asar = surfaceError('asar', e);
  }
  try {
    const result = AGENT.apply(agentPath, options);
    agent = { surface: 'agent', path: agentPath, status: result.status, ok: true, patches: result.patches };
  } catch (e) {
    agent = surfaceError('agent', e);
  }
  return { ok: !!(asar.ok && agent.ok), asar, agent };
}

export function rollbackAll(options = {}) {
  const asarPath = options.asarPath ?? defaultAsarPath;
  const agentPath = options.agentPath ?? defaultAgentPath;
  let asar;
  let agent;
  // Reverse order of apply: agent first, then asar. Both are independent files,
  // so order does not affect correctness, but keeping LIFO is explicit.
  try {
    const result = AGENT.rollback(agentPath);
    agent = { surface: 'agent', path: agentPath, status: result.status, ok: true };
  } catch (e) {
    agent = surfaceError('agent', e);
  }
  try {
    const result = ASAR.rollback(asarPath, options);
    asar = { surface: 'asar', path: asarPath, status: result.status, ok: true };
  } catch (e) {
    asar = surfaceError('asar', e);
  }
  return { ok: !!(asar.ok && agent.ok), asar, agent };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function bilingual(zh, en) {
  return zh.join('\n') + '\n\n--- English ---\n' + en.join('\n');
}

function statusZh(status) {
  return { patchable: '可打补丁', applied: '已打补丁', 'already-applied': '已应用', restored: '已回滚', 'already-restored': '无需回滚', unknown: '未知签名', partial: '部分打补丁', missing: '文件缺失', error: '失败' }[status] || status;
}

function describe(item, zh, en, includeCrash) {
  const label = item.surface === 'asar' ? '[ASAR app.asar]' : '[CLI glm/zcode.cjs]';
  const detail = item.status === 'error' ? item.error : statusZh(item.status) + (item.patches ? '（' + item.patches.length + ' 条）' : '');
  zh.push(label + ' ' + detail);
  en.push(label + ' ' + detail);
  for (const p of item.problems || []) { zh.push('  - ' + p); en.push('  - ' + p); }
  if (includeCrash && item.crash) {
    zh.push('  - 崩溃上报检查（只读 fail-closed）：' + (item.crash.ok ? '通过' : '未通过') + '（' + item.crash.reason + '）');
    en.push('  - crash-report check (read-only fail-closed): ' + (item.crash.ok ? 'pass' : 'fail') + ' (' + item.crash.reason + ')');
  }
}

function cli() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const confirm = argv.includes('--confirm');
  const acceptRisk = argv.includes('--accept-embedded-integrity-risk');
  const args = argv.slice(1);
  const flag = name => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const consumed = new Set();
  for (const name of ['--asar', '--agent']) {
    const i = args.indexOf(name);
    if (i >= 0) { consumed.add(i); consumed.add(i + 1); }
  }
  const positional = args.filter((a, i) => !a.startsWith('--') && !consumed.has(i));
  const options = {
    asarPath: flag('--asar') ?? positional[0],
    agentPath: flag('--agent') ?? positional[1],
    acceptEmbeddedIntegrityRisk: acceptRisk,
  };
  if (!options.asarPath) delete options.asarPath;
  if (!options.agentPath) delete options.agentPath;

  const zh = [];
  const en = [];
  try {
    if (command === 'check') {
      const result = checkAll(options);
      zh.push('检查两个上报面：'); en.push('Checking both upload surfaces:');
      describe(result.asar, zh, en, true);
      describe(result.agent, zh, en, false);
      for (const w of result.warnings || []) { zh.push('警告：' + w); en.push('Warning: ' + w); }
      zh.push(result.ok ? '结果：两个上报面均可处理。' : '结果：存在需要处理的问题。');
      en.push(result.ok ? 'Result: both surfaces are actionable.' : 'Result: problems need attention.');
      process.exitCode = result.ok ? 0 : 1;
    } else if (command === 'apply') {
      if (!confirm) throw Error('apply requires --confirm');
      const result = applyAll(options);
      zh.push('应用两个上报面（各自独立、备份保留）：'); en.push('Applying both upload surfaces (independent, backups preserved):');
      describe(result.asar, zh, en, false);
      describe(result.agent, zh, en, false);
      zh.push(result.ok ? '结果：两个上报面均已处理；需要完全退出并重新启动 ZCode。' : '结果：至少一个上报面失败；已写入的备份不会被删除，请按分项状态处理。');
      en.push(result.ok ? 'Result: both surfaces handled; a full quit and restart of ZCode is required.' : 'Result: at least one surface failed; existing backups are kept, handle per-item status.');
      process.exitCode = result.ok ? 0 : 1;
    } else if (command === 'verify') {
      const result = verifyAll(options);
      zh.push('验证两个上报面：'); en.push('Verifying both upload surfaces:');
      describe(result.asar, zh, en, true);
      describe(result.agent, zh, en, false);
      zh.push(result.ok ? '结果：两个上报面验证通过。' : '结果：验证未通过。');
      en.push(result.ok ? 'Result: both surfaces verified.' : 'Result: verification failed.');
      process.exitCode = result.ok ? 0 : 1;
    } else if (command === 'rollback') {
      if (!confirm) throw Error('rollback requires --confirm');
      const result = rollbackAll(options);
      zh.push('回滚两个上报面（LIFO：先 CLI 后 ASAR）：'); en.push('Rolling back both upload surfaces (LIFO: CLI then ASAR):');
      describe(result.agent, zh, en, false);
      describe(result.asar, zh, en, false);
      zh.push(result.ok ? '结果：两个上报面均已回滚。' : '结果：至少一个上报面回滚失败。');
      en.push(result.ok ? 'Result: both surfaces rolled back.' : 'Result: at least one surface failed to roll back.');
      process.exitCode = result.ok ? 0 : 1;
    } else {
      zh.push('用法：node telemetry-all.mjs <check|apply|verify|rollback> [app.asar] [zcode.cjs] [--confirm] [--asar path] [--agent path]');
      en.push('Usage: node telemetry-all.mjs <check|apply|verify|rollback> [app.asar] [zcode.cjs] [--confirm] [--asar path] [--agent path]');
      process.exitCode = 1;
    }
  } catch (e) {
    zh.push('错误：' + e.message);
    en.push('Error: ' + e.message);
    process.exitCode = 1;
  }
  console.log(bilingual(zh, en));
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) cli();
