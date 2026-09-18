import { spawnSync } from 'node:child_process';

const script = process.argv[2];
if (!['check', 'test', 'apply', 'verify', 'rollback'].includes(script)) {
  console.error('Usage: node run-package.mjs check|test|apply|verify|rollback');
  process.exit(2);
}
const available = spawnSync('bun', ['--version'], { stdio: 'ignore' });
const useBun = !available.error && available.status === 0;
console.log(`Package runner: ${useBun ? 'bun' : 'npm'} run ${script}`);
// npm is a .cmd wrapper on Windows. Invoke it through cmd explicitly rather
// than relying on whichever shell GNU Make happened to select.
const windowsNpm = !useBun && process.platform === 'win32';
const command = windowsNpm ? (process.env.ComSpec || 'cmd.exe') : (useBun ? 'bun' : 'npm');
const args = windowsNpm ? ['/d', '/s', '/c', `npm run ${script}`] : ['run', script];
const result = spawnSync(command, args, { stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
