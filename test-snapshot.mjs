import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Offline suites for the repo snapshot privacy patch. The real installation is
// opened read-only; every write happens in a temporary directory.
const suites = [
  ['tests/test-snapshot-logic.mjs', '补丁逻辑：原位等长替换、ASAR 头部几何、融合开关与内嵌完整性判定', 'Patch logic: in-place equal-length replacement, ASAR header geometry, fuse and embedded-integrity assessment'],
  ['tests/test-snapshot-apply.mjs', '端到端：合成 ASAR 上的 apply/verify/rollback、未知签名、外部改动与备份损坏拒绝', 'End-to-end: apply/verify/rollback on a synthetic ASAR, unknown signature, external change and corrupted backup refusal'],
  ['tests/test-snapshot-mocks.mjs', '副作用计数：真实方法的原始版本触发 mock，已补丁版本零副作用', 'Side effects: original real methods trigger mocks, patched methods are inert'],
];
const zh = ['仓库快照采集上传禁用补丁：离线测试', '测试只读取真实安装，不会写入 Program Files，也不会启动或重启 ZCode。'];
const en = ['Repo snapshot privacy patch: offline tests', 'Tests only read the real installation; no writes to Program Files and no ZCode process is started.'];
let failed = false;
let skipped = false;
let details = '';
console.log('正在运行快照补丁离线测试，请稍候……');
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
  zh.push('这不代表补丁已应用；应用后需要完全退出并重新启动 ZCode 才会生效。', '下一步：npm run snapshot:check 查看安装状态；需要应用时运行 npm run snapshot:apply。');
  en.push('This does not mean the patch is installed; a full quit and restart of ZCode is required after applying.', 'Next: npm run snapshot:check to inspect the installation; npm run snapshot:apply to install.');
}
console.log('\n' + zh.join('\n') + '\n\n--- English ---\n' + en.join('\n'));
if (details) console.error('\n--- Details ---\n' + details);
