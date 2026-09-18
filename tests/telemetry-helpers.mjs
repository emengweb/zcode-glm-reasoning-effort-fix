// Read-only helpers for extracting real code from the installed ZCode bundle.
// Used by the mock/behaviour suites; nothing here writes to the installation.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { defaultAsar, readAsarHeader, getEntry, readEntryBuffer } from '../telemetry-patch.mjs';

export const realGlmPath = path.join(path.dirname(defaultAsar), 'glm', 'zcode.cjs');

export function realEntryText(entryPath) {
  if (!fs.existsSync(defaultAsar)) return null;
  const meta = readAsarHeader(defaultAsar);
  try {
    const entry = getEntry(meta.header, entryPath);
    return readEntryBuffer(meta.fd, meta, entry).toString('utf8');
  } finally {
    fs.closeSync(meta.fd);
  }
}

// Returns the balanced brace-delimited function body starting at `marker`.
// Parameter lists (including default values such as `t={}`) are skipped so the
// body brace, not a brace inside the parameters, is used.
export function extractFunction(text, marker) {
  const start = text.indexOf(marker);
  if (start < 0) throw Error('Marker not found: ' + marker);
  const parenStart = text.indexOf('(', start);
  const firstBrace = text.indexOf('{', start);
  let bodyStart;
  if (parenStart >= 0 && (firstBrace < 0 || parenStart < firstBrace)) {
    let depth = 0;
    let j = parenStart;
    for (; j < text.length; j++) {
      if (text[j] === '(') depth++;
      else if (text[j] === ')') {
        depth--;
        if (depth === 0) { j++; break; }
      }
    }
    bodyStart = text.indexOf('{', j);
  } else {
    bodyStart = firstBrace;
  }
  if (bodyStart < 0) throw Error('No body after marker: ' + marker);
  let depth = 0;
  let inStr = null;
  let esc = false;
  for (let i = bodyStart; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw Error('Unbalanced braces after marker: ' + marker);
}

// Evaluates a `name={...}` object literal from a bundle in an isolated context.
export function extractObjectLiteral(text, name) {
  const marker = name + '={';
  const start = text.indexOf(marker);
  if (start < 0) throw Error('Object literal not found: ' + name);
  const src = extractBalancedFrom(text, start + marker.length - 1);
  const context = vm.createContext({});
  return vm.runInContext('(' + src + ')', context, { filename: 'extracted-object.js' });
}

function extractBalancedFrom(text, braceStart) {  let depth = 0;
  let inStr = null;
  let esc = false;
  for (let i = braceStart; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(braceStart, i + 1);
    }
  }
  throw Error('Unbalanced object literal');
}

// Counts contiguous differing byte runs between two equal-length buffers.
export function changedRegions(a, b) {
  if (a.length !== b.length) throw Error('Buffers differ in length');
  const regions = [];
  let start = -1;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      regions.push({ start, length: i - start });
      start = -1;
    }
  }
  if (start >= 0) regions.push({ start, length: a.length - start });
  return regions;
}

// Faithful stand-in for the bundle's `Kqe` valid-http-url helper (the real one
// is only a thin URL wrapper); kept local so the test does not depend on its
// minified name staying stable.
export function validHttpUrl(value) {
  const t = value?.trim();
  if (!t) return undefined;
  try {
    const u = new URL(t);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    if (u.username || u.password) return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}
