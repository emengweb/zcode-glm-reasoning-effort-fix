// Offline test helpers for the repo snapshot privacy patch.
// Everything runs in temporary directories; the real installation is only read.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const zh = [];
export const en = [];
let failed = false;
let skipped = false;

export function check(condition, zhText, enText) {
  if (condition) {
    zh.push('[通过] ' + zhText);
    en.push('[PASS] ' + enText);
  } else {
    failed = true;
    zh.push('[未通过] ' + zhText);
    en.push('[FAIL] ' + enText);
  }
}

// Records a check that could not be performed (for example because the real
// installation is absent) so the suite summary cannot claim full coverage.
export function skip(zhText, enText) {
  skipped = true;
  zh.push('[跳过] ' + zhText);
  en.push('[SKIP] ' + enText);
}

export function assert(condition, message) {
  if (!condition) throw Error('Assertion failed: ' + message);
}

export function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw Error('Assertion failed: ' + message + ' (actual ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected) + ')');
  }
}

export function assertThrows(fn, pattern, message) {
  try {
    fn();
  } catch (e) {
    if (pattern && !pattern.test(e.message)) {
      throw Error('Assertion failed: ' + message + ' (threw "' + e.message + '" which does not match ' + pattern + ')');
    }
    return e;
  }
  throw Error('Assertion failed: ' + message + ' (no error thrown)');
}

export function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

export function report(titleZh, titleEn, process_) {
  zh.unshift(titleZh);
  en.unshift(titleEn);
  if (failed) {
    zh.push('结果：本套测试未全部通过。');
    en.push('Result: this suite did not fully pass.');
  } else if (skipped) {
    zh.push('结果：本套测试通过，但含跳过项（见上），不代表已完整覆盖。');
    en.push('Result: this suite passed but contains skipped checks (see above); it is not full coverage.');
  } else {
    zh.push('结果：本套测试全部通过。');
    en.push('Result: this suite passed all checks.');
  }
  console.log(zh.join('\n') + '\n\n--- English ---\n' + en.join('\n'));
  process_.exitCode = failed ? 1 : 0;
}
