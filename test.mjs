import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const suites = [
  ['tests/test-mapping.mjs', '映射规则：保留推理等级，Responses 不变，重复应用结果一致', 'Mapping: reasoning preserved, Responses unchanged, repeat application safe'],
  ['tests/integration.mjs', '集成检查：六种等级、两种请求体、备份回滚和文件保护（优先使用受校验原始备份）', 'Integration: six levels, two request formats, backup/rollback and file protection (verified original backup first)'],
  ['tests/test-rule-source.mjs', '规则来源解析：优先受校验备份，回退固定夹具', 'Rule source resolution: verified backup first, fixed fixture fallback'],
  ['test-snapshot.mjs', '快照隐私补丁：逻辑、端到端与副作用计数（真实安装只读）', 'Snapshot privacy patch: logic, end-to-end and side-effect counting (real install read-only)'],
];
const zh = ['离线测试', '这些测试不会调用真实模型，也不会应用补丁，不会启动或重启 ZCode；快照测试只读取真实安装。'];
const en = ['Offline tests', 'No live model requests and the patch will not be applied. ZCode is not started or restarted; snapshot tests only read the real installation.'];
const failures = [];
console.log('正在运行离线测试，请稍候……');
for (const [file, cn, english] of suites) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(file, import.meta.url))], { encoding: 'utf8' });
  if (!result.error && result.status === 0) {
    zh.push(`[通过] ${cn}`);
    en.push(`[PASS] ${english}`);
  } else {
    zh.push(`[未通过] ${cn}`);
    en.push(`[FAIL] ${english}`);
    failures.push({
      cn,
      english,
      details: result.error?.message || result.stderr || result.stdout || `Exit code: ${result.status}`,
    });
  }
}
if (failures.length) {
  zh.push('失败原因：请查看下方各组技术详情。', '集成测试会优先从受校验的原始备份（或回退固定夹具）构造未打补丁输入，不再要求安装处于未打补丁状态；因此失败通常意味着补丁逻辑、备份完整性或测试环境本身需要检查，而不是「安装已被打过补丁」。');
  en.push('Why it failed: see the per-suite details below.', 'The integration test now builds its unpatched input from a verified original backup (or falls back to a fixed fixture), so it no longer requires an unpatched installation. A failure therefore points at the patch logic, backup integrity or the test environment rather than "the installation is already patched".');
  zh.push('结果：测试未全部通过，请先解决上述问题。');
  en.push('Result: not all tests passed. Resolve the issue above before proceeding.');
  process.exitCode = 1;
} else {
  zh.push('结果：全部离线测试通过。', '这里只验证补丁逻辑，不代表补丁已应用或线上对话已恢复。', '下一步：make verify 查看推理补丁安装状态；需要应用时运行 make apply。', '快照隐私补丁另见 SNAPSHOT-PRIVACY.md，先用 npm run snapshot:check 检查。');
  en.push('Result: all offline tests passed.', 'This does not mean the patch is installed or live conversations are fixed.', 'Next: make verify to inspect the reasoning-patch installation; make apply to install it.', 'For the snapshot privacy patch see SNAPSHOT-PRIVACY.md and start with npm run snapshot:check.');
}
console.log('\n' + zh.join('\n') + '\n\n--- English ---\n' + en.join('\n'));
if (failures.length) {
  const sections = failures.map(f => `### ${f.cn}\n${f.english}\n\n${f.details}`).join('\n\n');
  console.error('\n--- Details ---\n' + sections);
}
