import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const suites = [
  ['tests/test-mapping.mjs', '映射规则：保留推理等级，Responses 不变，重复应用结果一致', 'Mapping: reasoning preserved, Responses unchanged, repeat application safe'],
  ['tests/integration.mjs', '集成检查：六种等级、两种请求体、备份回滚和文件保护', 'Integration: six levels, two request formats, backup/rollback and file protection'],
];
console.log('离线测试 / Offline tests\n这些测试不会调用真实模型，也不会应用补丁。\nNo live model requests; the patch will not be applied.\n');
let failed = false;
for (const [file, zh, en] of suites) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(file, import.meta.url))], {encoding:'utf8'});
  if (!result.error && result.status === 0) {
    console.log(`[通过 / PASS] ${zh}\n  ${en}\n`);
  } else {
    failed = true;
    console.error(`[未通过 / FAIL] ${zh}\n  ${en}`);
    console.error('请查看下方详情。集成检查需要默认路径下、尚未打补丁的兼容版本；未通过不一定表示补丁本身有错。');
    console.error('See details below. Integration requires a compatible, unpatched installation at the default path; failure does not necessarily mean the patch is defective.');
    console.error(result.error?.message || result.stderr || result.stdout || `Exit code: ${result.status}`);
    break;
  }
}
if (failed) {
  console.error('\n结果：测试未全部通过，请先解决上述问题。\nResult: not all tests passed. Resolve the issue above before proceeding.');
  process.exitCode = 1;
} else {
  console.log('结果：全部离线测试通过。这里只验证补丁逻辑，不代表补丁已应用或线上对话已恢复。');
  console.log('Result: all offline tests passed. This does not mean the patch is installed or live conversations are fixed.');
  console.log('下一步：make verify 查看安装状态；需要应用时运行 make apply。');
  console.log('Next: make verify to inspect installation; make apply when you want to install the patch.');
}
