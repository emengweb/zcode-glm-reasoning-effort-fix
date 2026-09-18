import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Offline suites for the telemetry / extra-report privacy patch. The real
// installation is opened read-only; every write happens in a temporary
// directory.
const suites = [
  ['tests/test-telemetry-logic.mjs', '补丁逻辑：等长替换、幂等、真实字节比对与模型路径不变', 'Patch logic: equal-length replacement, idempotency, real-byte comparison and unchanged model path'],
  ['tests/test-telemetry-apply.mjs', '端到端：合成 ASAR 上的 apply/verify/rollback、未知签名与备份损坏拒绝', 'End-to-end: apply/verify/rollback on a synthetic ASAR, unknown signature and corrupted-backup refusal'],
  ['tests/test-telemetry-mocks.mjs', '行为验证：真实提取函数 + mock 证明原始触发网络、已补丁零网络、模型遥测开关与 ARMS 开关', 'Behaviour: real extracted functions + mocks prove original network, patched zero network, model-telemetry and ARMS switches'],
  ['tests/test-telemetry-interaction.mjs', '组合兼容：与快照补丁两种应用顺序及 LIFO 回滚、乱序拒绝', 'Interaction: both application orders with the snapshot patch, LIFO rollback and out-of-order refusal'],
  ['tests/test-agent-telemetry-logic.mjs', 'Agent 硬阻断逻辑：单入口 H4n 等长替换与真实字节比对', 'Agent hard-block logic: single-entry H4n equal-length replacement and real-byte comparison'],
  ['tests/test-agent-telemetry-apply.mjs', 'Agent 硬阻断端到端：合成文件 apply/verify/rollback 与拒绝路径', 'Agent hard-block end-to-end: synthetic-file apply/verify/rollback and refusal paths'],
  ['tests/test-agent-telemetry-mocks.mjs', 'Agent 硬阻断行为：有效端点 + 开关 true 下零初始化', 'Agent hard-block behaviour: zero initialisation with a valid endpoint and the switch on'],
];
const zh = ['ZCode 遥测/额外上报禁用补丁：离线测试', '测试只读取真实安装，不会写入 Program Files，也不会启动或重启 ZCode。'];
const en = ['ZCode telemetry / extra-report privacy patch: offline tests', 'Tests only read the real installation; no writes to Program Files and no ZCode process is started.'];
let failed = false;
let skipped = false;
let details = '';
console.log('正在运行遥测补丁离线测试，请稍候……');
for (const [file, cn, english] of suites) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(file, import.meta.url))], { encoding: 'utf8' });
  if (!result.error && result.status === 0) {
    const suiteSkipped = /\[SKIP\]/.test(result.stdout || '');
    if (suiteSkipped) skipped = true;
    zh.push(`[通过${suiteSkipped ? '·含跳过' : ''}] ${cn}`);
    en.push(`[PASS${suiteSkipped ? ' (with skipped checks)' : ''}] ${english}`);
  } else {
    failed = true;
    zh.push(`[未通过] ${cn}`, '请查看下方技术详情。');
    en.push(`[FAIL] ${english}`, 'See the technical details below.');
    details = result.error?.message || result.stderr || result.stdout || `Exit code: ${result.status}`;
    break;
  }
}
if (failed) {
  zh.push('结果：测试未全部通过，请先解决上述问题。', '不要在没有全部通过的情况下应用补丁。');
  en.push('Result: not all tests passed. Resolve the issue above first.', 'Do not apply the patch until every suite passes.');
  process.exitCode = 1;
} else {
  zh.push('结果：全部离线测试通过。');
  en.push('Result: all offline test suites passed.');
  if (skipped) {
    zh.push('注意：有套件包含跳过项（上方 [跳过]），不代表已完整覆盖。');
    en.push('Note: some suites contain skipped checks (see [SKIP] above); this is not full coverage.');
  }
  zh.push('这不代表补丁已应用；应用后需要完全退出并重新启动 ZCode 才会生效。', '下一步：npm run telemetry:check 查看安装状态；需要应用时运行 npm run telemetry:apply。');
  en.push('This does not mean the patch is installed; a full quit and restart of ZCode is required after applying.', 'Next: npm run telemetry:check to inspect the installation; npm run telemetry:apply to install.');
}
console.log('\n' + zh.join('\n') + '\n\n--- English ---\n' + en.join('\n'));
if (details) console.error('\n--- Details ---\n' + details);
