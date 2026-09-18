// ZCode repo snapshot privacy patch (disable capture/upload of repository snapshots).
//
// Scope of this module: it rewrites exactly five methods inside the single ASAR
// entry out/host/index.js so that repository snapshot capture and upload never
// start, and it updates that entry's ASAR integrity hash/blocks. Nothing else in
// the archive is modified; every other entry keeps its original bytes and
// integrity metadata.
//
// It is deliberately strict: the host entry must match a pinned version
// signature (known original SHA256, entry offset/size and header geometry).
// Unknown files are rejected instead of being rewritten.
//
// Standalone. No third-party dependency. Node >= 18.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const defaultAsar = 'C:/Program Files/ZCode/resources/app.asar';
export const HOST_ENTRY_PATH = 'out/host/index.js';
export const PATCH_MARKER = 'snapshot-privacy:disabled';

const NOTE = PATCH_MARKER;

// Pinned version signature for ZCode 3.12.3 (Electron 41.0.3).
// hostPatchedSha256 is the deterministic result of applying PATCH_SPECS below.
export const KNOWN_VERSION = {
  appVersion: '3.12.3',
  electron: '41.0.3',
  headerInts: [4, 7013000, 7012996, 7012990],
  dataStart: 7013008,
  jsonLen: 7012990,
  hostEntryOffset: '244037758',
  hostEntrySize: 2588119,
  hostOriginalSha256: 'c8f7b2e50f2c8f7eeb030a377cfc4779b2a0e2037af2239e065157dc2e3e422e',
  hostPatchedSha256: "5b356cbaf445315bd6421457caafe98e116ebe626513616a1d0b47bc30e5d033",
};

// Exact original method bodies (minified, byte-for-byte) that this patch
// replaces. Matching is exact and must occur exactly once per method.
const PATCH_SPECS = [
  {
    id: 'repoSnapshotSidecar.captureBeforePrompt',
    prefix: 'async captureBeforePrompt(t){',
    body: 'return',
    original: "async captureBeforePrompt(t){t.workspaceIdentity?.trim()||await this.captureScheduler.schedule(t,async o=>{let n=t.signal?AbortSignal.any([t.signal,o]):o;await this.captureBeforePromptUnsafe({...t,signal:n})})}",
  },
  {
    id: 'repoSnapshotUploadWorker.flushWorkspace',
    prefix: 'async flushWorkspace(t){',
    body: 'return',
    original: "async flushWorkspace(t){let r=uo(t),n=(this.flushesByWorkspaceKey.get(r)??Promise.resolve()).catch(()=>{}).then(()=>this.flushWorkspaceLoop(t)).catch(()=>{}).finally(()=>{this.flushesByWorkspaceKey.get(r)===n&&this.flushesByWorkspaceKey.delete(r)});this.flushesByWorkspaceKey.set(r,n),await n}",
  },
  {
    id: 'repoSnapshotUploadWorker.flushActiveUpload',
    prefix: 'async flushActiveUpload(t){',
    body: 'return!1',
    original: "async flushActiveUpload(t){let r=await this.stateRepo.read(t),o=r.activeUpload??r.pendingUpload;if(!o)return!1;let n=await this.tokenProvider();if(!n)return!1;let i=await this.pendingManager.recordUploadAttempt(t,o);if(!i)return this.consumePendingCredential(o),!0;if(i.failureCountedAt){if(!r.latestPendingUpload)return this.consumePendingCredential(i),!1;let p=await this.pendingManager.discardPendingUpload(t,i);return this.consumePendingCredential(i),p===\"promoted\"}let s=i.uploadCredentialHandle?.trim();if(!s)return await this.pendingManager.discardPendingUpload(t,i)===\"promoted\";let c=await this.buildUploadTargetRequest({stateWorkspaceKey:r.workspaceKey,pending:i,uploadCredentialHandle:s}),l=await this.uploadClient.requestUploadTarget(n,c,t.traceId);if(!l.ok){if(l.reason===\"base_not_found\"||l.reason===\"base_invalid\"||l.reason===\"hash_mismatch\")return await this.stateRepo.clearAcceptedManifest(t),await this.pendingManager.discardPendingUpload(t,i,{discardLatest:!0}),this.consumePendingCredential(i),r.latestPendingUpload&&this.consumePendingCredential(r.latestPendingUpload),!1;if(l.reason===\"key_expired\"){let f=await this.pendingManager.discardPendingUpload(t,i);return this.consumePendingCredential(i),f===\"promoted\"}if(l.reason===\"payload_too_large\"){let f=await pdt(i.manifestPath);await this.pendingManager.recordCompressedSize(t,{encryptedSizeBytes:c.encryptedArtifact.encryptedSizeBytes,workspaceSizeBytes:f,manifestHash:i.nextManifestHash,recordedAt:Date.now()});let m=await this.pendingManager.discardPendingUpload(t,i);return this.consumePendingCredential(i),m===\"promoted\"}let p=await this.pendingManager.failPendingUpload(t,i);return p!==\"retained\"&&this.consumePendingCredential(i),p===\"promoted\"}if(!(await this.uploadClient.uploadObject({target:l.objectUpload,artifactPath:i.encryptedArtifactPath,traceId:t.traceId})).ok){let p=await this.pendingManager.failPendingUpload(t,i);return p!==\"retained\"&&this.consumePendingCredential(i),p===\"promoted\"}return this.consumePendingCredential(i),await this.pendingManager.markAcceptedManifest(t,i,{manifestHash:i.nextManifestHash,manifestPath:i.manifestPath,extraManifestHash:i.nextExtraManifestHash,extraManifestPath:i.extraManifestPath})===\"promoted\"}",
  },
  {
    id: 'repoSnapshotUploadClient.getUploadCredential',
    prefix: 'async getUploadCredential(t,r,o){',
    body: 'return null',
    original: "async getUploadCredential(t,r,o){let n=Vlt(r),i=await Ot(this.apiClient,n,{method:\"GET\",headers:qlt(t),timeoutMs:this.credentialTimeoutMs,signal:o}),s=vIe(i);return s?(Xlt(s),s):null}",
  },
  {
    id: 'repoSnapshotUploadClient.uploadObject',
    prefix: 'async uploadObject(t){',
    body: 'return{ok:!1,reason:"snapshot_upload_disabled"}',
    original: "async uploadObject(t){let r=this.objectUploadFetch??Wlt,o=AbortSignal.timeout(this.objectUploadTimeoutMs),n=t.signal?AbortSignal.any([t.signal,o]):o;try{let i=t.target.method===\"PUT\"?await odt({fetchImpl:r,target:t.target,artifactPath:t.artifactPath,signal:n}):await idt({fetchImpl:r,target:t.target,artifactPath:t.artifactPath,signal:n}),s=i.ok?void 0:await Jlt(i);return i.ok?{ok:!0,etag:i.headers.get(\"etag\")??void 0}:{ok:!1,reason:\"object_upload_failed\",message:s?`HTTP ${i.status}: ${s}`:`HTTP ${i.status}`}}catch(i){return{ok:!1,reason:\"object_upload_failed\",message:i instanceof Error?i.message:String(i)}}}",
  },
];

export const PATCHES = PATCH_SPECS;

export const hash = b => crypto.createHash('sha256').update(b).digest('hex');
export const hashText = s => hash(Buffer.from(s, 'utf8'));

export function countOccurrences(text, needle) {
  if (!needle) throw Error('Empty needle');
  let count = 0;
  let i = text.indexOf(needle);
  while (i !== -1) {
    count++;
    i = text.indexOf(needle, i + needle.length);
  }
  return count;
}

// Builds a replacement of exactly the same byte length as the original method,
// so the ASAR entry offset/size and the header geometry stay untouched.
// Lengths are measured in UTF-8 bytes, not UTF-16 code units: the replacement is
// pure ASCII, so a non-ASCII original would otherwise shrink the written region.
export function buildPatched(spec) {
  const overhead = Buffer.byteLength(spec.prefix) + Buffer.byteLength(NOTE) + 5 + Buffer.byteLength(spec.body);
  const pad = Buffer.byteLength(spec.original) - overhead;
  if (pad < 0) throw Error('Patch note does not fit in ' + spec.id);
  return spec.prefix + '/*' + NOTE + ' '.repeat(pad) + '*/' + spec.body + '}';
}

export function patchedAnchor(spec) {
  return spec.prefix + '/*' + NOTE;
}

// Applies every patch to the host bundle text. Idempotent: if a method already
// carries the marker it is reported as already patched instead of being changed
// twice. Any ambiguous or unknown signature aborts the whole transformation.
export function transformHost(text) {
  const applied = [];
  const already = [];
  for (const spec of PATCHES) {
    const original = spec.original;
    if (!original.startsWith(spec.prefix) || !original.endsWith('}')) {
      throw Error('Internal patch spec invalid for ' + spec.id);
    }
    const patched = buildPatched(spec);
    if (Buffer.byteLength(patched) !== Buffer.byteLength(original)) {
      throw Error('Internal patch length mismatch for ' + spec.id);
    }
    const originalCount = countOccurrences(text, original);
    if (originalCount === 1) {
      text = text.split(original).join(patched);
      applied.push(spec.id);
      continue;
    }
    if (originalCount === 0 && countOccurrences(text, patchedAnchor(spec)) === 1) {
      already.push(spec.id);
      continue;
    }
    throw Error(
      'Unknown host signature for ' + spec.id + ' (original matches: ' + originalCount + '); refusing modification'
    );
  }
  return { text, changed: applied.length > 0, applied, already, total: PATCHES.length };
}

export function readFully(fd, buffer, offset, length, position) {
  let done = 0;
  while (done < length) {
    const read = fs.readSync(fd, buffer, offset + done, length - done, position + done);
    if (read <= 0) throw Error('Unexpected end of file while reading');
    done += read;
  }
  return done;
}

// Writes every byte, retrying short writes: fs.writeSync may legally write fewer
// bytes than requested, and a silent short write would corrupt the archive.
export function writeFully(fd, buffer, position) {
  let done = 0;
  while (done < buffer.length) {
    const written = fs.writeSync(fd, buffer, done, buffer.length - done, position + done);
    if (written <= 0) throw Error('Short write while modifying the archive; refusing to continue');
    done += written;
  }
  return done;
}

export function hashRegion(fd, start, length) {
  const h = crypto.createHash('sha256');
  const chunk = Buffer.alloc(8 * 1024 * 1024);
  let pos = start;
  let remaining = length;
  while (remaining > 0) {
    const n = Math.min(chunk.length, remaining);
    readFully(fd, chunk, 0, n, pos);
    h.update(chunk.subarray(0, n));
    pos += n;
    remaining -= n;
  }
  return h.digest('hex');
}

// Hashes the archive as it would look with the given byte ranges replaced.
// `replacements` must be sorted, non-overlapping, of equal length to the regions
// they cover, and inside [0, size). Used to predict the post-patch archive hash
// before writing and to prove that bytes outside the patchable regions are intact.
export function hashWithReplacements(fd, size, replacements) {
  const reps = [...replacements].sort((a, b) => a.start - b.start);
  let prevEnd = 0;
  for (const rep of reps) {
    if (!Number.isSafeInteger(rep.start) || rep.start < prevEnd || rep.start + rep.buffer.length > size) {
      throw Error('Invalid replacement region while hashing the archive');
    }
    prevEnd = rep.start + rep.buffer.length;
  }
  const h = crypto.createHash('sha256');
  const chunk = Buffer.alloc(8 * 1024 * 1024);
  let pos = 0;
  let ri = 0;
  while (pos < size) {
    if (ri < reps.length && pos === reps[ri].start) {
      h.update(reps[ri].buffer);
      pos += reps[ri].buffer.length;
      ri++;
      continue;
    }
    let n = Math.min(chunk.length, size - pos);
    if (ri < reps.length) n = Math.min(n, reps[ri].start - pos);
    readFully(fd, chunk, 0, n, pos);
    h.update(chunk.subarray(0, n));
    pos += n;
  }
  return h.digest('hex');
}

export function align4(n) {
  return n + ((4 - (n % 4)) % 4);
}

// Parses the ASAR prefix exactly as Electron's pickle reader does:
//   uint32 @0 = 4, uint32 @4 = header size, uint32 @8 = header pickle payload,
//   uint32 @12 = JSON length, JSON starts at 16.
// The data area starts at 8 + uint32(4); "16 + jsonLen" is NOT the data start
// because the JSON is padded to a 4-byte boundary.
export function parseHeaderBuffers(prefix, jsonBuf) {
  const size0 = prefix.readUInt32LE(0);
  const headerSize = prefix.readUInt32LE(4);
  const picklePayload = prefix.readUInt32LE(8);
  const jsonLen = prefix.readUInt32LE(12);
  if (size0 !== 4) throw Error('Unsupported ASAR layout: leading uint32 is not 4');
  // Pickle layout: payload = 4-byte string length + string data + padding that
  // aligns the data to 4 bytes. The header region adds its own 4-byte size word.
  if (picklePayload !== 4 + align4(jsonLen)) throw Error('Unsupported ASAR layout: pickle payload mismatch');
  if (headerSize !== 4 + picklePayload) throw Error('Unsupported ASAR layout: header size mismatch');
  const dataStart = 8 + headerSize;
  if (align4(16 + jsonLen) !== dataStart) {
    throw Error('Unsupported ASAR layout: header padding mismatch');
  }
  if (jsonBuf.length !== jsonLen) throw Error('Unsupported ASAR layout: header JSON length mismatch');
  const jsonText = jsonBuf.toString('utf8');
  let header;
  try {
    header = JSON.parse(jsonText);
  } catch {
    throw Error('Unsupported ASAR layout: header JSON is not parseable');
  }
  return { size0, headerSize, picklePayload, jsonLen, dataStart, jsonText, header };
}

export function readAsarHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const prefix = Buffer.alloc(16);
    readFully(fd, prefix, 0, 16, 0);
    const jsonLen = prefix.readUInt32LE(12);
    if (jsonLen <= 0 || jsonLen > prefix.readUInt32LE(4)) {
      throw Error('Unsupported ASAR layout: implausible header JSON length');
    }
    const jsonBuf = Buffer.alloc(jsonLen);
    readFully(fd, jsonBuf, 0, jsonLen, 16);
    const meta = parseHeaderBuffers(prefix, jsonBuf);
    return { fd, prefix, jsonBuf, ...meta, fileSize: fs.fstatSync(fd).size, headerInts: [prefix.readUInt32LE(0), prefix.readUInt32LE(4), prefix.readUInt32LE(8), prefix.readUInt32LE(12)] };
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
}

export function getEntry(header, entryPath) {
  const parts = entryPath.split('/');
  let node = header;
  for (const part of parts) {
    if (!node || !node.files || !node.files[part]) throw Error('ASAR entry not found: ' + entryPath);
    node = node.files[part];
  }
  return node;
}

export function readEntryBuffer(fd, meta, entry) {
  const size = Number(entry.size);
  const offset = Number(entry.offset);
  if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(offset) || offset < 0) {
    throw Error('ASAR entry has invalid size/offset');
  }
  if (meta.dataStart + offset + size > meta.fileSize) throw Error('ASAR entry points outside the archive');
  const buffer = Buffer.alloc(size);
  readFully(fd, buffer, 0, size, meta.dataStart + offset);
  return buffer;
}

// Blocks describe SHA256 over consecutive blockSize chunks of the file content.
// Zero-byte files still carry exactly one block (the hash of empty content),
// which is what the real archive stores.
export function blockHashes(buffer, blockSize) {
  const count = Math.max(1, Math.ceil(buffer.length / blockSize));
  const blocks = [];
  for (let i = 0; i < count; i++) {
    blocks.push(hash(buffer.subarray(i * blockSize, Math.min((i + 1) * blockSize, buffer.length))));
  }
  return blocks;
}

export function verifyIntegrityBlocks(entry, buffer) {
  const integrity = entry.integrity;
  if (!integrity) return { ok: false, reason: 'missing integrity' };
  if (integrity.algorithm !== 'SHA256') return { ok: false, reason: 'unsupported algorithm ' + integrity.algorithm };
  const whole = hash(buffer);
  if (integrity.hash !== whole) return { ok: false, reason: 'whole-file hash mismatch' };
  const blockSize = Number(integrity.blockSize);
  if (!Number.isSafeInteger(blockSize) || blockSize <= 0) return { ok: false, reason: 'invalid blockSize' };
  const expected = Array.isArray(integrity.blocks) ? integrity.blocks : [];
  const actual = blockHashes(buffer, blockSize);
  if (actual.length !== expected.length) return { ok: false, reason: 'block count mismatch' };
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) return { ok: false, reason: 'block ' + i + ' mismatch' };
  }
  return { ok: true, blocks: actual.length };
}

export function expectedBlocks(buffer, blockSize) {
  return blockHashes(buffer, blockSize);
}

// ---------------------------------------------------------------------------
// Version signature / status
// ---------------------------------------------------------------------------

export function resolveExpectations(override) {
  return { ...KNOWN_VERSION, ...(override || {}) };
}

export function assertKnownSignature(meta, entry, hostSha, expected) {
  const problems = [];
  if (expected.dataStart !== meta.dataStart) problems.push('header data start ' + meta.dataStart + ' != ' + expected.dataStart);
  if (expected.jsonLen !== meta.jsonLen) problems.push('header JSON length ' + meta.jsonLen + ' != ' + expected.jsonLen);
  if (String(entry.offset) !== String(expected.hostEntryOffset)) problems.push('entry offset ' + entry.offset + ' != ' + expected.hostEntryOffset);
  if (Number(entry.size) !== Number(expected.hostEntrySize)) problems.push('entry size ' + entry.size + ' != ' + expected.hostEntrySize);
  if (hostSha !== expected.hostOriginalSha256) problems.push('host SHA256 ' + hostSha + ' != ' + expected.hostOriginalSha256);
  if (problems.length) throw Error('Unknown ZCode host signature: ' + problems.join('; ') + '. Refusing to modify.');
}

export function hostStatus(hostSha, expected) {
  if (hostSha === expected.hostOriginalSha256) return 'patchable';
  if (hostSha === expected.hostPatchedSha256) return 'applied';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Electron executable: fuse wire + embedded ASAR integrity resource
// ---------------------------------------------------------------------------

export const FUSE_NAMES = [
  'RunAsNode',
  'EnableCookieEncryption',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges',
];

export const FUSE_WIRE_MAGIC = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';

// Layout: magic(32) + version(1) + count(1) + states(count) + zero padding.
export function parseFuseWire(buffer, offset) {
  const magic = Buffer.from(FUSE_WIRE_MAGIC, 'ascii');
  if (offset < 0 || offset + magic.length + 2 > buffer.length) throw Error('Fuse wire out of range');
  if (buffer.indexOf(magic, offset) !== offset) throw Error('Fuse wire magic mismatch');
  const version = buffer[offset + magic.length];
  const count = buffer[offset + magic.length + 1];
  if (count < 0 || offset + magic.length + 2 + count > buffer.length) throw Error('Fuse wire state table truncated');
  const states = buffer.toString('latin1', offset + magic.length + 2, offset + magic.length + 2 + count);
  const named = {};
  for (let i = 0; i < count; i++) {
    named[FUSE_NAMES[i] || 'unknownFuse' + i] = states[i];
  }
  return { offset, version, count, states, named };
}

export function findFuseWire(fd) {
  const magic = Buffer.from(FUSE_WIRE_MAGIC, 'ascii');
  const size = fs.fstatSync(fd).size;
  const chunkSize = 8 * 1024 * 1024;
  const chunk = Buffer.alloc(chunkSize);
  let carry = Buffer.alloc(0);
  let pos = 0;
  while (pos < size) {
    const n = Math.min(chunkSize, size - pos);
    readFully(fd, chunk, 0, n, pos);
    const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
    const local = data.indexOf(magic);
    if (local !== -1) return parseFuseWire(data, local);
    carry = Buffer.from(data.subarray(Math.max(0, data.length - magic.length + 1)));
    pos += n;
  }
  return null;
}

export function parsePeSections(buffer) {
  if (buffer.length < 0x40) throw Error('Not a PE file');
  const peOff = buffer.readUInt32LE(0x3c);
  if (buffer.toString('ascii', peOff, peOff + 4) !== 'PE\u0000\u0000') throw Error('Not a PE file');
  const coff = peOff + 4;
  const sectionCount = buffer.readUInt16LE(coff + 2);
  const optionalSize = buffer.readUInt16LE(coff + 16);
  const optional = coff + 20;
  const magic = buffer.readUInt16LE(optional);
  const is64 = magic === 0x20b;
  const dataDir = optional + (is64 ? 112 : 96);
  const sections = [];
  const tableOff = optional + optionalSize;
  for (let i = 0; i < sectionCount; i++) {
    const s = tableOff + i * 40;
    sections.push({
      name: buffer.toString('ascii', s, s + 8).replace(/\u0000+$/, ''),
      virtualSize: buffer.readUInt32LE(s + 8),
      virtualAddress: buffer.readUInt32LE(s + 12),
      rawSize: buffer.readUInt32LE(s + 16),
      rawOffset: buffer.readUInt32LE(s + 20),
    });
  }
  return { sections, dataDirOffset: dataDir, sectionCount };
}

export function rvaToOffset(sections, rva) {
  for (const s of sections) {
    const span = Math.max(s.virtualSize, s.rawSize);
    if (rva >= s.virtualAddress && rva < s.virtualAddress + span) {
      return s.rawOffset + (rva - s.virtualAddress);
    }
  }
  return -1;
}

// Walks the PE resource directory and returns leaf resources.
// `buffer` must be the raw .rsrc section content: all directory/name offsets in
// a PE resource tree are relative to the start of that section. Leaf data
// offsets are absolute RVAs and are resolved to file offsets here.
export function parsePeResources(buffer, sections) {
  const results = [];
  const readName = raw => {
    if (raw & 0x80000000) {
      const no = raw & 0x7fffffff;
      const len = buffer.readUInt16LE(no);
      return buffer.toString('utf16le', no + 2, no + 2 + len * 2);
    }
    return '#' + (raw & 0xffff);
  };
  const walk = (dirOffset, level, names) => {
    if (level > 4 || dirOffset + 16 > buffer.length) return;
    const named = buffer.readUInt16LE(dirOffset + 12);
    const ids = buffer.readUInt16LE(dirOffset + 14);
    for (let i = 0; i < named + ids; i++) {
      const entry = dirOffset + 16 + i * 8;
      if (entry + 8 > buffer.length) return;
      const nameRaw = buffer.readUInt32LE(entry);
      const subRaw = buffer.readUInt32LE(entry + 4);
      const name = readName(nameRaw);
      const sub = subRaw & 0x7fffffff;
      if (subRaw & 0x80000000) {
        walk(sub, level + 1, names.concat(name));
      } else {
        if (sub + 8 > buffer.length) return;
        const dataRva = buffer.readUInt32LE(sub);
        const dataSize = buffer.readUInt32LE(sub + 4);
        results.push({
          type: names[0] ?? '',
          name: names[1] ?? name,
          lang: name,
          path: names.concat(name),
          dataOffset: rvaToOffset(sections, dataRva),
          dataSize,
        });
      }
    }
  };
  walk(0, 0, []);
  return results;
}

export function readEmbeddedAsarIntegrity(exePath) {
  const fd = fs.openSync(exePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const headLen = Math.min(size, 0x2000);
    const head = Buffer.alloc(headLen);
    readFully(fd, head, 0, headLen, 0);
    const { sections, dataDirOffset } = parsePeSections(head);
    const rsrcRva = head.readUInt32LE(dataDirOffset + 2 * 8);
    const rsrcSize = head.readUInt32LE(dataDirOffset + 2 * 8 + 4);
    if (!rsrcRva || !rsrcSize) return { present: false, entries: [] };
    const rsrcOff = rvaToOffset(sections, rsrcRva);
    if (rsrcOff < 0 || rsrcOff + rsrcSize > size) return { present: false, entries: [] };
    const rsrc = Buffer.alloc(rsrcSize);
    readFully(fd, rsrc, 0, rsrcSize, rsrcOff);
    const resources = parsePeResources(rsrc, sections);
    const entries = [];
    for (const res of resources) {
      if (!/ELECTRONASAR/i.test(String(res.name)) && !/ELECTRONASAR/i.test(String(res.type))) continue;
      if (res.dataOffset < 0 || res.dataSize <= 0 || res.dataSize > 65536) continue;
      const raw = Buffer.alloc(res.dataSize);
      readFully(fd, raw, 0, res.dataSize, res.dataOffset);
      try {
        const parsed = JSON.parse(raw.toString('utf8'));
        if (Array.isArray(parsed)) entries.push(...parsed);
      } catch {
        /* not JSON, ignore */
      }
    }
    return { present: entries.length > 0, entries };
  } finally {
    fs.closeSync(fd);
  }
}

export function inspectExecutable(exePath, headerHashes) {
  if (!exePath || !fs.existsSync(exePath)) {
    return { exists: false, fuse: null, embedded: { present: false, entries: [] }, assessment: { risk: 'none', reason: 'executable not found; embedded integrity not applicable' } };
  }
  const fd = fs.openSync(exePath, 'r');
  let fuse = null;
  try {
    fuse = findFuseWire(fd);
  } finally {
    fs.closeSync(fd);
  }
  let embedded = { present: false, entries: [] };
  let embeddedError = null;
  try {
    embedded = readEmbeddedAsarIntegrity(exePath);
  } catch (e) {
    embeddedError = e.message;
  }
  const enabled = fuse ? fuse.named.EnableEmbeddedAsarIntegrityValidation === '1' : false;
  const matches = [];
  for (const entry of embedded.entries) {
    for (const [name, value] of Object.entries(headerHashes || {})) {
      if (entry.value && entry.value === value) matches.push({ file: entry.file, definition: name });
    }
  }
  // Fail closed: when validation is enabled, anything we cannot positively rule
  // out (unparsable resource, missing resource, unmatched hash) is "uncertain",
  // which apply refuses to touch unless the caller explicitly accepts the risk.
  let assessment;
  if (!enabled) {
    assessment = { risk: 'none', reason: 'EnableEmbeddedAsarIntegrityValidation fuse is disabled' };
  } else if (embeddedError) {
    assessment = { risk: 'uncertain', reason: 'embedded ASAR integrity validation is enabled but the resource could not be parsed: ' + embeddedError };
  } else if (!embedded.present) {
    assessment = { risk: 'uncertain', reason: 'embedded ASAR integrity validation is enabled but no integrity resource was found' };
  } else if (matches.length) {
    assessment = { risk: 'blocking', reason: 'embedded ASAR integrity matches the current header and validation is enabled' };
  } else {
    assessment = { risk: 'uncertain', reason: 'embedded integrity enabled but its value does not match this header; cannot prove the check passes after a header change' };
  }
  return {
    exists: true,
    size: fs.statSync(exePath).size,
    fuse,
    fuseEnabled: enabled,
    embedded,
    embeddedError,
    embeddedIntegrityMatches: matches,
    assessment,
  };
}

// ---------------------------------------------------------------------------
// Backup / receipt helpers
// ---------------------------------------------------------------------------

export function backupPaths(target) {
  return {
    header: target + '.snapshot-privacy.header.bak',
    host: target + '.snapshot-privacy.host.bak',
    receipt: target + '.snapshot-privacy.receipt.json',
  };
}

// Parses a receipt, turning a truncated/hand-edited file into a clear error
// instead of a raw JSON SyntaxError the CLI cannot explain.
export function parseReceipt(text) {
  let receipt;
  try {
    receipt = JSON.parse(text);
  } catch {
    throw Error('Backup receipt is not valid JSON; refusing to use it');
  }
  if (!receipt || typeof receipt !== 'object' || receipt.version !== 1) throw Error('Unsupported receipt version');
  return receipt;
}

export function loadReceipt(target) {
  const paths = backupPaths(target);
  if (!fs.existsSync(paths.receipt)) return null;
  const receipt = parseReceipt(fs.readFileSync(paths.receipt, 'utf8'));
  for (const key of ['header', 'host']) {
    const file = paths[key];
    if (!fs.existsSync(file)) throw Error('Backup file missing: ' + file);
    const actual = hash(fs.readFileSync(file));
    if (actual !== receipt.backup[key + 'Sha256']) throw Error('Backup integrity failure for ' + key + ' backup');
  }
  return receipt;
}

// ---------------------------------------------------------------------------
// check / verify / apply / rollback
// ---------------------------------------------------------------------------

export function checkState(target, options = {}) {
  const expected = resolveExpectations(options.expected);
  const meta = readAsarHeader(target);
  try {
    const entry = getEntry(meta.header, HOST_ENTRY_PATH);
    const hostBuf = readEntryBuffer(meta.fd, meta, entry);
    const hostSha = hash(hostBuf);
    const status = hostStatus(hostSha, expected);
    const integrity = verifyIntegrityBlocks(entry, hostBuf);
    const headerHashes = {
      headerJson: hash(meta.jsonBuf),
      headerRegionFrom8: hashRegion(meta.fd, 8, meta.dataStart - 8),
    };
    const exePath = options.exePath ?? path.join(path.dirname(path.dirname(target)), 'ZCode.exe');
    const exe = options.inspectExe === false ? null : inspectExecutable(exePath, headerHashes);
    const receipt = fs.existsSync(backupPaths(target).receipt);
    return { target, meta, entry, hostBuf, hostSha, status, integrity, headerHashes, exe, receipt, expected };
  } finally {
    fs.closeSync(meta.fd);
  }
}

export function apply(target, options = {}) {
  const expected = resolveExpectations(options.expected);
  const paths = backupPaths(target);
  const meta = readAsarHeader(target);
  fs.closeSync(meta.fd);
  // readAsarHeader opens read-only; the apply path needs read-write.
  const fd = fs.openSync(target, 'r+');
  const closeFd = () => { try { fs.closeSync(fd); } catch { /* already closed */ } };
  meta.fileSize = fs.fstatSync(fd).size;
  try {
    const entry = getEntry(meta.header, HOST_ENTRY_PATH);
    const hostBuf = readEntryBuffer(fd, meta, entry);
    const hostSha = hash(hostBuf);
    const status = hostStatus(hostSha, expected);
    if (status === 'applied') return { status: 'already-applied', target };
    if (status === 'unknown') {
      throw Error('Unknown host SHA256 ' + hostSha + '; known signatures are ' + expected.hostOriginalSha256 + ' (original) and ' + expected.hostPatchedSha256 + ' (patched). Refusing to modify.');
    }
    assertKnownSignature(meta, entry, hostSha, expected);
    const integrityCheck = verifyIntegrityBlocks(entry, hostBuf);
    if (!integrityCheck.ok) throw Error('Host entry integrity is inconsistent before patching: ' + integrityCheck.reason);

    const headerHashes = {
      headerJson: hash(meta.jsonBuf),
      headerRegionFrom8: hashRegion(fd, 8, meta.dataStart - 8),
    };
    const exePath = options.exePath ?? path.join(path.dirname(path.dirname(target)), 'ZCode.exe');
    const exe = options.inspectExe === false ? null : inspectExecutable(exePath, headerHashes);
    if (exe && exe.assessment.risk === 'blocking' && !options.acceptEmbeddedIntegrityRisk) {
      throw Error('Embedded ASAR integrity validation is enabled and matches the current header. Changing the header would break startup. Refusing to modify.');
    }
    if (exe && exe.assessment.risk === 'uncertain' && !options.acceptEmbeddedIntegrityRisk) {
      throw Error('Embedded ASAR integrity is enabled but could not be proven inactive. Refusing to modify without --accept-embedded-integrity-risk.');
    }

    if (fs.existsSync(paths.header) || fs.existsSync(paths.host) || fs.existsSync(paths.receipt)) {
      throw Error('Backup exists: inspect or rollback first');
    }

    const transformed = transformHost(hostBuf.toString('utf8'));
    if (!transformed.changed) throw Error('Nothing to patch: host bundle already carries the marker');
    const patchedBuf = Buffer.from(transformed.text, 'utf8');
    if (patchedBuf.length !== hostBuf.length) throw Error('Patched host length changed; refusing to write');
    const patchedSha = hash(patchedBuf);
    if (patchedSha !== expected.hostPatchedSha256) {
      throw Error('Patched host SHA256 ' + patchedSha + ' != expected ' + expected.hostPatchedSha256 + '. Refusing to write.');
    }

    const oldIntegrity = entry.integrity;
    const blockSize = Number(oldIntegrity.blockSize);
    const newBlocks = expectedBlocks(patchedBuf, blockSize);
    // Replace the entry's whole integrity object (not just the hash hex) so that
    // multi-block entries are handled too. Key order is preserved, and every
    // value keeps its length, so the header JSON length cannot change.
    const oldIntegrityJson = JSON.stringify(oldIntegrity);
    if (countOccurrences(meta.jsonText, oldIntegrityJson) !== 1) {
      throw Error('Host entry integrity block is not unique in the header; refusing to write');
    }
    const newIntegrity = { ...oldIntegrity, hash: patchedSha, blocks: newBlocks };
    const newIntegrityJson = JSON.stringify(newIntegrity);
    if (newIntegrityJson.length !== oldIntegrityJson.length) {
      throw Error('New integrity metadata changed length; refusing to write');
    }
    const newJsonText = meta.jsonText.replace(oldIntegrityJson, newIntegrityJson);
    if (newJsonText.length !== meta.jsonText.length) throw Error('Header rewrite changed its length; refusing to write');
    const newJsonBuf = Buffer.from(newJsonText, 'utf8');
    let newHeader;
    try {
      newHeader = JSON.parse(newJsonText);
    } catch {
      throw Error('Rewritten header is not valid JSON; refusing to write');
    }
    const newEntry = getEntry(newHeader, HOST_ENTRY_PATH);
    if (newEntry.integrity.hash !== patchedSha || String(newEntry.size) !== String(entry.size)) {
      throw Error('Rewritten header integrity does not match the patched host; refusing to write');
    }
    if (JSON.stringify(newEntry.integrity.blocks) !== JSON.stringify(newBlocks)) {
      throw Error('Rewritten header blocks do not match the patched host; refusing to write');
    }

    // Header region [8, dataStart): 8 bytes of pickle prefixes + JSON + padding.
    // It keeps its exact length, so dataStart and every entry offset stay valid.
    const originalRegion = Buffer.alloc(meta.headerSize);
    readFully(fd, originalRegion, 0, meta.headerSize, 8);
    if (hash(originalRegion) !== headerHashes.headerRegionFrom8) throw Error('Target changed while reading the header');
    const newRegion = Buffer.concat([
      originalRegion.subarray(0, 8),
      newJsonBuf,
      originalRegion.subarray(8 + meta.jsonLen),
    ]);
    if (newRegion.length !== meta.headerSize) throw Error('Header region length changed; refusing to write');
    if (hash(newRegion.subarray(8, 8 + meta.jsonLen)) !== hash(newJsonBuf)) throw Error('Rewritten header region is malformed; refusing to write');

    const beforeAsarSha = hashRegion(fd, 0, meta.fileSize);
    // Predicted post-patch hash of the whole archive, streamed from disk before
    // anything is written. It lets the receipt be persisted once, in its final
    // form, and it is the value the actual result is compared against below.
    const expectedAfterSha = hashWithReplacements(fd, meta.fileSize, [
      { start: 8, buffer: newRegion },
      { start: meta.dataStart + Number(entry.offset), buffer: patchedBuf },
    ]);

    // Backup: only the two regions this patch can change, plus a signed receipt.
    // The receipt is written before the archive is touched and already carries the
    // final post-patch hash, so an interrupted apply never leaves a null/incomplete
    // receipt behind.
    fs.writeFileSync(paths.header, originalRegion, { flag: 'wx' });
    fs.writeFileSync(paths.host, hostBuf, { flag: 'wx' });
    const receipt = {
      version: 1,
      tool: 'snapshot-patch.mjs',
      createdAt: new Date().toISOString(),
      target,
      hostEntry: HOST_ENTRY_PATH,
      knownVersion: expected.appVersion,
      before: {
        asarSha256: beforeAsarSha,
        headerSha256: headerHashes.headerRegionFrom8,
        hostSha256: hostSha,
        fileSize: meta.fileSize,
        dataStart: meta.dataStart,
        jsonLen: meta.jsonLen,
        headerSize: meta.headerSize,
        entryOffset: String(entry.offset),
        entrySize: Number(entry.size),
        entryIntegrity: oldIntegrity,
      },
      after: {
        asarSha256: expectedAfterSha,
        headerSha256: hash(newRegion),
        hostSha256: patchedSha,
        entryIntegrity: newEntry.integrity,
      },
      backup: {
        headerSha256: hash(fs.readFileSync(paths.header)),
        hostSha256: hash(fs.readFileSync(paths.host)),
      },
      patches: transformed.applied,
      embeddedIntegrity: exe ? { assessment: exe.assessment, fuseEnabled: exe.fuseEnabled, fuseStates: exe.fuse?.states ?? null } : null,
    };
    fs.writeFileSync(paths.receipt, JSON.stringify(receipt, null, 2), { flag: 'wx' });

    // Concurrency guard: the archive must not have changed since we read it.
    const recheck = hashRegion(fd, 0, meta.fileSize);
    if (recheck !== beforeAsarSha) {
      fs.unlinkSync(paths.receipt);
      fs.unlinkSync(paths.host);
      fs.unlinkSync(paths.header);
      throw Error('Target changed concurrently; refusing write');
    }

    writeFully(fd, newRegion, 8);
    writeFully(fd, patchedBuf, meta.dataStart + Number(entry.offset));
    fs.fsyncSync(fd);

    const afterAsarSha = hashRegion(fd, 0, meta.fileSize);

    const verifyFd = fs.openSync(target, 'r');
    try {
      const verifyHeader = Buffer.alloc(meta.headerSize);
      readFully(verifyFd, verifyHeader, 0, meta.headerSize, 8);
      if (hash(verifyHeader) !== receipt.after.headerSha256) throw Error('Post-write verification failed: header hash mismatch');
      const reread = Buffer.alloc(hostBuf.length);
      readFully(verifyFd, reread, 0, hostBuf.length, meta.dataStart + Number(entry.offset));
      if (hash(reread) !== patchedSha) throw Error('Post-write verification failed: host content mismatch');
    } finally {
      fs.closeSync(verifyFd);
    }
    if (afterAsarSha !== expectedAfterSha) {
      throw Error('Post-write verification failed: archive hash ' + afterAsarSha + ' != expected ' + expectedAfterSha);
    }
    return { status: 'applied', target, backup: paths, patches: transformed.applied, asarSha256: afterAsarSha };
  } finally {
    closeFd();
  }
}

export function verify(target, options = {}) {
  const expected = resolveExpectations(options.expected);
  const meta = readAsarHeader(target);
  const problems = [];
  try {
    const entry = getEntry(meta.header, HOST_ENTRY_PATH);
    const hostBuf = readEntryBuffer(meta.fd, meta, entry);
    const hostSha = hash(hostBuf);
    const status = hostStatus(hostSha, expected);
    if (status !== 'applied') problems.push('host bundle is not patched (status: ' + status + ')');
    const hostIntegrity = verifyIntegrityBlocks(entry, hostBuf);
    if (!hostIntegrity.ok) problems.push('host integrity: ' + hostIntegrity.reason);

    // Every other entry must still match its own integrity metadata.
    let checked = 0;
    let skippedUnpacked = 0;
    const ranges = [];
    const walk = node => {
      if (node.files) {
        for (const child of Object.values(node.files)) walk(child);
        return;
      }
      if (node.unpacked || node.offset === undefined) { skippedUnpacked++; return; }
      const buffer = readEntryBuffer(meta.fd, meta, node);
      const result = verifyIntegrityBlocks(node, buffer);
      if (!result.ok) problems.push('entry integrity failure: ' + result.reason);
      ranges.push([Number(node.offset), Number(node.offset) + Number(node.size)]);
      checked++;
    };
    walk(meta.header);
    ranges.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i][0] < ranges[i - 1][1]) problems.push('entry offset overlap detected');
    }
    const dataSize = meta.fileSize - meta.dataStart;
    if (ranges.length && ranges[ranges.length - 1][1] > dataSize) problems.push('entry extends past data area');

    const asarSha = hashRegion(meta.fd, 0, meta.fileSize);
    let receipt = null;
    try {
      receipt = loadReceipt(target);
    } catch (e) {
      problems.push(e.message);
    }
    if (receipt) {
      if (!receipt.after.asarSha256) {
        // Interrupted or legacy receipt: without the post-patch hash there is no
        // baseline proving that entries other than the host are still original.
        problems.push('backup receipt has no post-patch archive hash; cannot prove other entries are unchanged');
      } else if (receipt.after.asarSha256 !== asarSha) {
        problems.push('archive hash does not match the receipt');
      }
    } else if (status === 'applied') {
      // Self-consistency alone cannot prove the rest of the archive is untouched,
      // so a positive verdict requires the receipt written by apply.
      problems.push('backup receipt is missing; cannot prove other entries are unchanged');
    }
    return { ok: problems.length === 0, status, hostSha, asarSha, entryIntegrity: hostIntegrity, checked, skippedUnpacked, problems, receipt: receipt ? { createdAt: receipt.createdAt, knownVersion: receipt.knownVersion, patches: receipt.patches, embeddedIntegrity: receipt.embeddedIntegrity } : null };
  } finally {
    fs.closeSync(meta.fd);
  }
}

export function rollback(target, options = {}) {
  const paths = backupPaths(target);
  const receipt = parseReceipt(fs.readFileSync(paths.receipt, 'utf8'));
  if (receipt.target !== target) throw Error('Receipt belongs to a different target; refusing destructive rollback');
  const headerBackup = fs.readFileSync(paths.header);
  const hostBackup = fs.readFileSync(paths.host);
  if (hash(headerBackup) !== receipt.backup.headerSha256) throw Error('Backup integrity failure for header backup');
  if (hash(hostBackup) !== receipt.backup.hostSha256) throw Error('Backup integrity failure for host backup');

  const dataStart = receipt.before.dataStart;
  const entryOffset = Number(receipt.before.entryOffset);
  const entrySize = Number(receipt.before.entrySize);
  if (headerBackup.length !== receipt.before.headerSize) throw Error('Backup header length mismatch');
  if (hostBackup.length !== entrySize) throw Error('Backup host length mismatch');

  const fd = fs.openSync(target, 'r+');
  try {
    const size = fs.fstatSync(fd).size;
    if (receipt.before.fileSize && size !== receipt.before.fileSize) {
      throw Error('Target size changed since patch; refusing destructive rollback');
    }
    const current = hashRegion(fd, 0, size);
    if (current === receipt.before.asarSha256) {
      fs.unlinkSync(paths.receipt);
      fs.unlinkSync(paths.host);
      fs.unlinkSync(paths.header);
      return { status: 'already-restored', target };
    }
    // Restoring is destructive, so accept only two states: exactly what apply
    // wrote, or a partial write / interrupted apply. In the latter case every
    // byte outside the two patchable regions must still hash to the pre-patch
    // archive, which is what rules out unrelated external modifications.
    if (!receipt.after.asarSha256 || current !== receipt.after.asarSha256) {
      const replacements = [
        { start: 8, buffer: headerBackup },
        { start: dataStart + entryOffset, buffer: hostBackup },
      ];
      let outside;
      try {
        outside = hashWithReplacements(fd, size, replacements);
      } catch (e) {
        throw Error('Target cannot hold the backed-up regions; refusing destructive rollback (' + e.message + ')');
      }
      if (outside !== receipt.before.asarSha256) {
        throw Error('Target changed outside the patched regions since patch; refusing destructive rollback');
      }
    }
    writeFully(fd, headerBackup, 8);
    writeFully(fd, hostBackup, dataStart + entryOffset);
    fs.fsyncSync(fd);
    const restored = hashRegion(fd, 0, size);
    if (restored !== receipt.before.asarSha256) throw Error('Rollback verification failed');
    fs.unlinkSync(paths.receipt);
    fs.unlinkSync(paths.host);
    fs.unlinkSync(paths.header);
    return { status: 'restored', target };
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function bilingual(zh, en) {
  return zh.join('\n') + '\n\n--- English ---\n' + en.join('\n');
}

function describeExe(exe, zh, en) {
  if (!exe) return;
  if (!exe.exists) { zh.push('未找到 ZCode.exe，跳过电子封装完整性检查。'); en.push('ZCode.exe not found; embedded integrity check skipped.'); return; }
  const fuse = exe.fuse;
  zh.push('电子封装检查：', `- 融合开关版本 ${fuse ? fuse.version : '未知'}，共 ${fuse ? fuse.count : '未知'} 项。`);
  en.push('Electron packaging check:', `- fuse wire version ${fuse ? fuse.version : 'unknown'}, ${fuse ? fuse.count : 'unknown'} entries.`);
  if (fuse) {
    zh.push(`- EnableEmbeddedAsarIntegrityValidation = ${fuse.named.EnableEmbeddedAsarIntegrityValidation ?? '未知'}（1 为启用，0 为关闭）。`);
    en.push(`- EnableEmbeddedAsarIntegrityValidation = ${fuse.named.EnableEmbeddedAsarIntegrityValidation ?? 'unknown'} (1 enabled, 0 disabled).`);
  }
  zh.push(`- 可执行文件内嵌 app.asar 完整性记录：${exe.embedded.present ? '存在' : '不存在'}。`);
  en.push(`- Embedded app.asar integrity record in the executable: ${exe.embedded.present ? 'present' : 'absent'}.`);
  if (exe.embeddedError) {
    zh.push(`- 内嵌完整性资源解析失败：${exe.embeddedError}`);
    en.push(`- Embedded integrity resource could not be parsed: ${exe.embeddedError}`);
  }
  zh.push(`- 阻断风险评估：${exe.assessment.risk}（${exe.assessment.reason}）。`);
  en.push(`- Blocking risk: ${exe.assessment.risk} (${exe.assessment.reason}).`);
}

function cli() {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'check';
  const valueOf = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const has = name => argv.includes(name);
  // Accept the target both as `--asar PATH` and as a positional argument (the
  // form used by the npm scripts and the Makefile), so an explicit path is never
  // silently ignored in favour of the default installation.
  const optionValues = new Set();
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--asar' || argv[i] === '--exe') optionValues.add(argv[i + 1]);
  }
  const positional = argv.slice(1).find(arg => !arg.startsWith('--') && !optionValues.has(arg));
  const target = valueOf('--asar') || positional || defaultAsar;
  const exePath = valueOf('--exe');
  const zh = [];
  const en = [];
  try {
    if (command === 'check') {
      const state = checkState(target, { exePath });
      zh.push('仓库快照采集上传禁用补丁：安装检查', `文件：${target}`);
      en.push('Repo snapshot privacy patch: installation check', `File: ${target}`);
      zh.push(`主机条目：${HOST_ENTRY_PATH}`, `主机 SHA256：${state.hostSha}`);
      en.push(`Host entry: ${HOST_ENTRY_PATH}`, `Host SHA256: ${state.hostSha}`);
      zh.push(`条目完整性：${state.integrity.ok ? '自洽' : '不一致（' + state.integrity.reason + '）'}`);
      en.push(`Entry integrity: ${state.integrity.ok ? 'consistent' : 'inconsistent (' + state.integrity.reason + ')'}`);
      if (state.status === 'patchable') {
        zh.push('状态：待修复（PATCHABLE）', '尚未禁用仓库快照采集上传。下一步：运行 npm run snapshot:apply。');
        en.push('Status: PATCHABLE', 'Snapshot capture/upload is still enabled. Next: npm run snapshot:apply.');
      } else if (state.status === 'applied') {
        zh.push('状态：已禁用（APPLIED）', '五个入口方法均已提前返回，条目完整性已同步更新。');
        en.push('Status: APPLIED', 'All five entry methods return early and the entry integrity metadata is updated.');
      } else {
        zh.push('状态：未知（UNKNOWN）', '主机文件与已知的原始/已补丁签名都不匹配，补丁拒绝修改。请核对 ZCode 版本。');
        en.push('Status: UNKNOWN', 'The host bundle matches neither the known original nor the known patched signature. The patch refuses to modify it. Check the ZCode version.');
      }
      describeExe(state.exe, zh, en);
      if (state.receipt) { zh.push('检测到备份收据，可用 npm run snapshot:rollback 回滚。'); en.push('A backup receipt exists; use npm run snapshot:rollback to restore.'); }
      zh.push('本次仅做只读检查，未修改任何文件，也未启动或重启 ZCode。');
      en.push('Read-only check: no file was modified and ZCode was not started or restarted.');
      console.log(bilingual(zh, en));
      return;
    }
    if (command === 'apply') {
      if (!has('--confirm')) throw Error('Explicit target and --confirm required');
      const result = apply(target, { exePath, acceptEmbeddedIntegrityRisk: has('--accept-embedded-integrity-risk') });
      zh.push('操作完成', result.status === 'already-applied' ? '补丁已存在，无需重复应用。' : '补丁已写入，原内容已备份，条目完整性已更新。', `文件：${target}`);
      en.push('Operation completed', result.status === 'already-applied' ? 'The patch is already present; nothing was reapplied.' : 'Patch written, original content backed up, entry integrity updated.', `File: ${target}`);
      if (result.patches) { zh.push('已禁用入口：' + result.patches.join('、')); en.push('Disabled entrypoints: ' + result.patches.join(', ')); }
      zh.push('需要完全退出并重新启动 ZCode 后才会生效。本次没有启动或重启 ZCode。');
      en.push('A full quit and restart of ZCode is required for the change to take effect. ZCode was not started or restarted.');
      console.log(bilingual(zh, en));
      return;
    }
    if (command === 'verify') {
      const result = verify(target, { exePath });
      zh.push('仓库快照采集上传禁用补丁：深度验证', `文件：${target}`, `状态：${result.status}`);
      en.push('Repo snapshot privacy patch: deep verification', `File: ${target}`, `Status: ${result.status}`);
      zh.push(`已校验条目：${result.checked} 个（跳过未打包条目 ${result.skippedUnpacked} 个）。`);
      en.push(`Verified entries: ${result.checked} (skipped unpacked entries: ${result.skippedUnpacked}).`);
      zh.push(`整个 ASAR SHA256：${result.asarSha}`);
      en.push(`Whole ASAR SHA256: ${result.asarSha}`);
      if (result.receipt) {
        zh.push(`收据时间：${result.receipt.createdAt}，目标版本：${result.receipt.knownVersion}`);
        en.push(`Receipt time: ${result.receipt.createdAt}, target version: ${result.receipt.knownVersion}`);
      }
      if (result.ok) {
        zh.push('结果：全部通过。五个入口方法已禁用，其他条目字节与完整性均未变化。');
        en.push('Result: all checks passed. The five entrypoints are disabled and every other entry keeps its original bytes and integrity.');
      } else {
        zh.push('结果：未通过。', ...result.problems.map(p => '- ' + p));
        en.push('Result: FAILED.', ...result.problems.map(p => '- ' + p));
        process.exitCode = 1;
      }
      console.log(bilingual(zh, en));
      return;
    }
    if (command === 'rollback') {
      if (!has('--confirm')) throw Error('Explicit target and --confirm required');
      const result = rollback(target, {});
      zh.push('操作完成', result.status === 'already-restored' ? '原文件已是打补丁前状态，已清理备份。' : '原文件已恢复，补丁已撤销。', `文件：${target}`);
      en.push('Operation completed', result.status === 'already-restored' ? 'The archive was already unpatched; backups were cleaned up.' : 'Original content restored; the patch was rolled back.', `File: ${target}`);
      zh.push('需要完全退出并重新启动 ZCode 后才会按旧行为运行。本次没有启动或重启 ZCode。');
      en.push('A full quit and restart of ZCode is required. ZCode was not started or restarted.');
      console.log(bilingual(zh, en));
      return;
    }
    throw Error('Usage: node snapshot-patch.mjs check|apply|verify|rollback [TARGET] [--asar PATH] [--exe PATH] [--confirm] [--accept-embedded-integrity-risk]');
  } catch (e) {
    let zhText;
    let enText;
    const explanations = [
      [/Explicit target/, '请提供目标路径和 --confirm 参数，确认后再应用或回滚。', 'Provide the target path and --confirm to apply or roll back.'],
      [/^Usage:/, '命令不受支持。可用命令：check、apply、verify、rollback。', 'Unsupported command. Available commands: check, apply, verify, rollback.'],
      [/Backup exists/, '已有备份或操作记录。请先检查上次结果，或回滚后再试；不要直接覆盖备份。', 'A backup or receipt already exists. Inspect the previous result or roll back before retrying; do not overwrite the backup.'],
      [/Backup integrity|Backup file missing|Backup header length|Backup host length|Backup receipt|Unsupported receipt/, '备份或收据校验失败，已停止操作。请保留备份并检查其来源。', 'Backup or receipt validation failed. The operation stopped; retain and inspect the backup.'],
      [/changed since|changed concurrently|changed outside the patched regions|cannot hold the backed-up regions/, '目标文件已被其他操作修改，为避免覆盖这些改动，本次操作已停止。', 'The target changed externally. The operation stopped to avoid overwriting those changes.'],
      [/verification failed|Post-write/, '写入后的校验失败，请保留备份并检查文件，不要直接重复操作。', 'Post-write verification failed. Retain the backup and inspect the file before retrying.'],
      [/Unknown host|Unknown ZCode|not unique|length changed|not valid JSON|Internal patch|Invalid replacement/, '主机文件与已知版本签名不符，补丁已拒绝修改。请核对 ZCode 版本或先回滚。', 'The host bundle does not match the supported version signature. The patch refused to modify it. Check the ZCode version or roll back first.'],
      [/Embedded ASAR integrity/, '可执行文件启用了内嵌 ASAR 完整性校验，修改头部可能导致应用无法启动，已拒绝修改。', 'Embedded ASAR integrity validation is active; changing the header could prevent startup, so the patch refused to modify it.'],
      [/Unsupported ASAR|truncated|outside the archive/, 'ASAR 结构不符合预期，已拒绝修改。', 'The ASAR structure is not the supported layout; the patch refused to modify it.'],
      [/Short write/, '写入未完成，归档可能处于中间状态。请勿重复操作，使用 rollback 恢复。', 'The write did not complete; the archive may be in an intermediate state. Do not retry blindly; use rollback to restore.'],
    ];
    const found = explanations.find(([re]) => re.test(e.message));
    if (found) {
      [, zhText, enText] = found;
    } else if (e.code === 'ENOENT') {
      zhText = '找不到所需文件，请检查安装路径或备份是否存在。';
      enText = 'Required file not found. Check the installation path or backup.';
    } else if (['EACCES', 'EPERM'].includes(e.code)) {
      zhText = '文件访问被拒绝。修改 Program Files 通常需要管理员权限，请在管理员终端中重试。\n无需为此关闭 ZCode。';
      enText = 'File access denied. Modifying Program Files usually requires an administrator terminal.\nYou do not need to close ZCode for this.';
    } else {
      zhText = '文件内容、版本签名或备份状态未通过检查，请根据下方详情排查。';
      enText = 'File content, version signature or backup state failed validation. See details below.';
    }
    console.error(bilingual([zhText], [enText]) + '\n\n--- Details ---\n' + e.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli();
}
