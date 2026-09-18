// Resolves where the integration test takes its "unpatched original" rule file
// from. The installed file may already carry the reasoning patch, so the test no
// longer assumes it is unpatched.
//
// Priority:
//   1. installed  - the installed rules are still unpatched; use them directly.
//   2. backup     - use the original backup, but only after verifying it against
//                   the receipt and against the currently installed (patched) file.
//   3. fixture    - a fixed, self-contained mapping fixture. The installed
//                   runtime wrapper is still read from the real installation.
import fs from 'node:fs';
import { transform, hash, defaultTarget } from '../patch.mjs';

export const defaultBackupPath = defaultTarget + '.reasoning-fix.bak';
export const defaultReceiptPath = defaultTarget + '.reasoning-fix.receipt.json';

// Mirrors the nested fragment that patch.mjs removes. Only used when neither the
// installed file nor a verified backup can provide the original mapping.
const MAP_EXPR = 'reasoningLevel == "disabled" ? "none" : reasoningLevel == "enabled" ? "high" : reasoningLevel';
export const FIXTURE_FRAGMENT = ',\n  "reasoning": {\n    "effort": ' + MAP_EXPR + '\n  }';
export const FIXTURE_MAP = '{\n  "reasoning_effort": ' + MAP_EXPR + '\n}';

function fixtureMapWithFragment() {
  // Insert the fragment just before the closing brace, exactly like the real mapping.
  return FIXTURE_MAP.replace(/\n\}$/, FIXTURE_FRAGMENT + '\n}');
}

export function fixtureRulesText() {
  return JSON.stringify({
    config: {
      modelConfigRules: {
        modelApiRules: [
          {
            modelMatch: '.*',
            apiTypeMatch: 'openai-chat-completions',
            config: { optionSpecs: { reasoningLevel: { map: fixtureMapWithFragment() } } },
          },
        ],
      },
    },
  });
}

function tryTransform(text) {
  try {
    return transform(text);
  } catch {
    return null;
  }
}

export function resolveRuleSource(installedText, options = {}) {
  const backupPath = options.backupPath ?? defaultBackupPath;
  const receiptPath = options.receiptPath ?? defaultReceiptPath;
  const installedHash = hash(Buffer.from(installedText, 'utf8'));

  const installedFixed = tryTransform(installedText);
  if (installedFixed && installedFixed.changed) {
    return {
      mode: 'installed',
      originalText: installedText,
      fixed: installedFixed,
      installedHash,
      reason: 'installed rules are not patched',
    };
  }

  const backupIssues = [];
  try {
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    const backupBuf = fs.readFileSync(backupPath);
    if (hash(backupBuf) !== receipt.before) throw Error('backup SHA256 does not match receipt.before');
    const backupText = backupBuf.toString('utf8');
    const fixed = transform(backupText);
    if (!fixed.changed) throw Error('backup is not an unpatched original');
    if (hash(Buffer.from(fixed.text, 'utf8')) !== receipt.after) throw Error('patched backup result does not match receipt.after');
    if (installedHash !== receipt.after) throw Error('installed rules are not the receipt.after result');
    return {
      mode: 'backup',
      originalText: backupText,
      fixed,
      installedHash,
      backupPath,
      receiptPath,
      reason: 'verified original backup',
    };
  } catch (e) {
    backupIssues.push(e.message);
  }

  const originalText = fixtureRulesText();
  return {
    mode: 'fixture',
    originalText,
    fixed: transform(originalText),
    installedHash,
    backupIssues,
    reason: 'fixed mapping fixture',
  };
}
