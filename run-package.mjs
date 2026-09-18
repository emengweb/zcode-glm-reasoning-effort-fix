import { spawnSync } from 'node:child_process';

function error(zh, en, details) {
  console.error(`命令执行失败\n${zh}\n\n--- English ---\nCommand failed\n${en}${details ? '\n\n--- Details ---\n' + details : ''}`);
}
const script = process.argv[2];
if (!['check', 'test', 'apply', 'verify', 'rollback'].includes(script)) {
  error('缺少命令或命令不受支持。可用命令：check、test、apply、verify、rollback。',
    'Missing or unsupported command. Available commands: check, test, apply, verify, rollback.',
    'Usage: node run-package.mjs check|test|apply|verify|rollback');
  process.exit(2);
}
const available = spawnSync('bun', ['--version'], { stdio: 'ignore' });
const useBun = !available.error && available.status === 0;
const windowsNpm = !useBun && process.platform === 'win32';
const command = windowsNpm ? (process.env.ComSpec || 'cmd.exe') : (useBun ? 'bun' : 'npm');
const args = windowsNpm ? ['/d', '/s', '/c', `npm run ${script}`] : ['run', script];
const result = spawnSync(command, args, { stdio: 'inherit' });
if (result.error) {
  error('无法启动命令。请确认已安装 Bun 或 npm，并且可从当前终端访问。',
    'Unable to start the command. Ensure Bun or npm is installed and available in this terminal.', result.error.message);
} else if (result.status !== 0) {
  error('子命令未成功完成，请查看上方错误说明。',
    'The child command did not complete successfully. See the error above.',
    `Command: ${useBun ? 'bun' : 'npm'} run ${script}\nExit code: ${result.status ?? 'unavailable'}${result.signal ? '\nSignal: ' + result.signal : ''}`);
}
process.exit(result.status ?? 1);
