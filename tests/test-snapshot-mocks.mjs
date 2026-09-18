// Suite 3: extract the real methods and prove, with a VM sandbox and side-effect
// counters, that the ORIGINAL methods trigger side effects (including the task
// completion "terminal" capture path and the pending-upload flush path) while
// the PATCHED methods perform none.
//
// The real installation is opened read-only; nothing is executed from it.
import fs from 'node:fs';
import vm from 'node:vm';
import { check, skip, report, assert, assertEqual } from './helpers.mjs';
import {
  PATCHES, buildPatched, countOccurrences, readAsarHeader, getEntry, readEntryBuffer,
  KNOWN_VERSION, HOST_ENTRY_PATH, defaultAsar, transformHost, hash,
} from '../snapshot-patch.mjs';

function specOf(suffix) {
  const spec = PATCHES.find(p => p.id.endsWith(suffix));
  if (!spec) throw Error('Unknown spec: ' + suffix);
  return spec;
}

function extractRealHost() {
  if (!fs.existsSync(defaultAsar)) return null;
  const meta = readAsarHeader(defaultAsar);
  try {
    const entry = getEntry(meta.header, HOST_ENTRY_PATH);
    return readEntryBuffer(meta.fd, meta, entry).toString('utf8');
  } finally {
    fs.closeSync(meta.fd);
  }
}

async function invoke(methodName, methodText, options = {}) {
  const context = vm.createContext({ AbortSignal, ...(options.sandbox || {}) });
  const Klass = vm.runInContext('(class { ' + methodText + ' })', context, { filename: 'extracted-method.js' });
  const instance = new Klass();
  Object.assign(instance, options.thisProps || {});
  return instance[methodName](...(options.args || []));
}

const total = counters => Object.values(counters).reduce((a, b) => a + b, 0);

try {
  // Verify the pinned originals are exactly the real bundle's bytes.
  const realHost = extractRealHost();
  if (realHost) {
    check(hash(Buffer.from(realHost, 'utf8')) === KNOWN_VERSION.hostOriginalSha256, '真实主机文件 SHA256 与版本签名一致', 'real host SHA256 matches the pinned version signature');
    const allPresent = PATCHES.every(p => countOccurrences(realHost, p.original) === 1);
    check(allPresent, '5 个原始方法均逐字节来自真实主机文件', 'all five originals are byte-exact substrings of the real bundle');
    const realPatched = transformHost(realHost);
    check(hash(Buffer.from(realPatched.text, 'utf8')) === KNOWN_VERSION.hostPatchedSha256, '真实主机变换后 SHA256 与钉住的已补丁签名一致', 'transforming the real host reproduces the pinned patched SHA256');
    check(Buffer.byteLength(realPatched.text) === Buffer.byteLength(realHost), '真实主机替换保持 UTF-8 字节长度不变', 'replacement keeps the real host UTF-8 byte length unchanged');
  } else {
    skip('未找到真实安装，跳过真实文件比对（仅使用钉住的方法文本）', 'real installation absent; real-file comparison skipped (pinned method texts only)');
  }

  // --- captureBeforePrompt (prompt + terminal/task-complete) ---------------
  {
    const spec = specOf('captureBeforePrompt');
    const patched = buildPatched(spec);
    const makeProps = counters => ({
      captureScheduler: {
        schedule: async (t, cb) => { counters.schedule++; return cb(new AbortController().signal); },
      },
      captureBeforePromptUnsafe: async () => { counters.unsafe++; },
    });
    const originalCounters = { schedule: 0, unsafe: 0 };
    await invoke('captureBeforePrompt', spec.original, {
      thisProps: makeProps(originalCounters),
      args: [{ workspaceIdentity: '', traceId: 't', captureStage: 'prompt' }],
    });
    check(originalCounters.schedule === 1 && originalCounters.unsafe === 1, '原始 captureBeforePrompt 会调度采集（prompt 阶段）', 'original captureBeforePrompt schedules capture (prompt stage)');

    const terminalCounters = { schedule: 0, unsafe: 0 };
    await invoke('captureBeforePrompt', spec.original, {
      thisProps: makeProps(terminalCounters),
      args: [{ workspaceIdentity: '   ', traceId: 't', captureStage: 'terminal' }],
    });
    check(terminalCounters.schedule === 1 && terminalCounters.unsafe === 1, '原始 captureBeforePrompt 会调度采集（terminal/任务完成阶段）', 'original captureBeforePrompt schedules capture (terminal / task-complete stage)');

    const patchedCounters = { schedule: 0, unsafe: 0 };
    const returned = await invoke('captureBeforePrompt', patched, {
      thisProps: makeProps(patchedCounters),
      args: [{ workspaceIdentity: '', traceId: 't', captureStage: 'terminal' }],
    });
    check(total(patchedCounters) === 0, '已补丁 captureBeforePrompt 零副作用', 'patched captureBeforePrompt has zero side effects');
    check(returned === undefined, '已补丁 captureBeforePrompt 立即返回', 'patched captureBeforePrompt returns immediately');
    check(!/await|schedule|Unsafe/.test(patched), '已补丁方法体不含调度/等待逻辑', 'patched body contains no scheduling or await logic');
  }

  // --- flushWorkspace -----------------------------------------------------
  {
    const spec = specOf('flushWorkspace');
    const patched = buildPatched(spec);
    const counters = { loop: 0, uo: 0 };
    const props = {
      flushesByWorkspaceKey: new Map(),
      flushWorkspaceLoop: async () => { counters.loop++; },
    };
    await invoke('flushWorkspace', spec.original, { sandbox: { uo: () => { counters.uo++; return 'k'; } }, thisProps: props, args: [{ workspacePath: 'w' }] });
    check(counters.loop === 1 && counters.uo === 1, '原始 flushWorkspace 会触发上传刷写循环', 'original flushWorkspace triggers the upload flush loop');
    const patchedCounters = { loop: 0, uo: 0 };
    await invoke('flushWorkspace', patched, { sandbox: { uo: () => { patchedCounters.uo++; return 'k'; } }, thisProps: props, args: [{ workspacePath: 'w' }] });
    check(total(patchedCounters) === 0, '已补丁 flushWorkspace 零副作用', 'patched flushWorkspace has zero side effects');
  }

  // --- flushActiveUpload (pending upload path) ----------------------------
  {
    const spec = specOf('flushActiveUpload');
    const patched = buildPatched(spec);
    const makeProps = counters => ({
      stateRepo: {
        read: async () => { counters.read++; return { workspaceKey: 'k', activeUpload: { uploadCredentialHandle: '' } }; },
        clearAcceptedManifest: async () => { counters.clear++; },
      },
      tokenProvider: async () => { counters.token++; return 'tok'; },
      pendingManager: {
        recordUploadAttempt: async (t, o) => { counters.attempt++; return o; },
        discardPendingUpload: async () => { counters.discard++; return 'retained'; },
        failPendingUpload: async () => { counters.fail++; return 'retained'; },
        recordCompressedSize: async () => { counters.size++; },
        markAcceptedManifest: async () => { counters.accept++; return 'retained'; },
      },
      consumePendingCredential: () => { counters.consume++; },
      buildUploadTargetRequest: async () => { counters.build++; return {}; },
      uploadClient: {
        requestUploadTarget: async () => { counters.request++; return { ok: false, reason: 'other' }; },
        uploadObject: async () => { counters.upload++; return { ok: true }; },
      },
    });
    const originalCounters = { read: 0, token: 0, attempt: 0, discard: 0, fail: 0, clear: 0, size: 0, accept: 0, consume: 0, build: 0, request: 0, upload: 0 };
    const originalResult = await invoke('flushActiveUpload', spec.original, { thisProps: makeProps(originalCounters), args: [{ workspacePath: 'w' }] });
    check(originalCounters.read === 1 && originalCounters.token === 1 && originalCounters.attempt === 1 && originalCounters.discard === 1, '原始 flushActiveUpload 会读取并处理待上传记录', 'original flushActiveUpload reads and processes a pending upload');
    check(originalResult === false, '原始 flushActiveUpload 返回布尔值', 'original flushActiveUpload returns a boolean');

    const patchedCounters = { read: 0, token: 0, attempt: 0, discard: 0, fail: 0, clear: 0, size: 0, accept: 0, consume: 0, build: 0, request: 0, upload: 0 };
    const patchedResult = await invoke('flushActiveUpload', patched, { thisProps: makeProps(patchedCounters), args: [{ workspacePath: 'w' }] });
    check(total(patchedCounters) === 0, '已补丁 flushActiveUpload 对待上传记录零副作用', 'patched flushActiveUpload has zero effect on pending uploads');
    check(patchedResult === false, '已补丁 flushActiveUpload 返回 false 以终止循环', 'patched flushActiveUpload returns false to end the loop');
  }

  // --- getUploadCredential (credential network request) -------------------
  {
    const spec = specOf('getUploadCredential');
    const patched = buildPatched(spec);
    const makeSandbox = counters => ({
      Vlt: () => 'url',
      qlt: () => ({}),
      Ot: async () => { counters.http++; return { handle: 'h' }; },
      vIe: i => i,
      Xlt: () => { counters.consume++; },
    });
    const originalCounters = { http: 0, consume: 0 };
    const originalResult = await invoke('getUploadCredential', spec.original, {
      sandbox: makeSandbox(originalCounters),
      thisProps: { apiClient: {}, credentialTimeoutMs: 1000 },
      args: ['tok', { providerId: 'p' }, undefined],
    });
    check(originalCounters.http === 1, '原始 getUploadCredential 会发起凭据网络请求', 'original getUploadCredential performs the credential network request');
    check(originalResult && originalResult.handle === 'h', '原始方法返回凭据对象', 'original method returns the credential');
    const patchedCounters = { http: 0, consume: 0 };
    const patchedResult = await invoke('getUploadCredential', patched, {
      sandbox: makeSandbox(patchedCounters),
      thisProps: { apiClient: {}, credentialTimeoutMs: 1000 },
      args: ['tok', { providerId: 'p' }, undefined],
    });
    check(total(patchedCounters) === 0, '已补丁 getUploadCredential 零网络副作用', 'patched getUploadCredential has zero network side effects');
    check(patchedResult === null, '已补丁 getUploadCredential 返回 null', 'patched getUploadCredential returns null');
  }

  // --- uploadObject (artifact PUT/POST) -----------------------------------
  {
    const spec = specOf('uploadObject');
    const patched = buildPatched(spec);
    const makeSandbox = counters => ({
      Wlt: async () => { throw Error('real fetch must not run'); },
      odt: async () => { counters.put++; return { ok: true, status: 200, headers: { get: () => 'etag-1' } }; },
      idt: async () => { counters.post++; return { ok: true, status: 200, headers: { get: () => undefined } }; },
      Jlt: async () => '',
    });
    const originalCounters = { put: 0, post: 0 };
    const putResult = await invoke('uploadObject', spec.original, {
      sandbox: makeSandbox(originalCounters),
      thisProps: { objectUploadTimeoutMs: 1000 },
      args: [{ target: { method: 'PUT' }, artifactPath: 'a' }],
    });
    check(originalCounters.put === 1 && putResult.ok === true, '原始 uploadObject 会执行 PUT 上传', 'original uploadObject performs the PUT upload');
    const originalCounters2 = { put: 0, post: 0 };
    await invoke('uploadObject', spec.original, {
      sandbox: makeSandbox(originalCounters2),
      thisProps: { objectUploadTimeoutMs: 1000 },
      args: [{ target: { method: 'POST' }, artifactPath: 'a' }],
    });
    check(originalCounters2.post === 1, '原始 uploadObject 会执行 POST 上传', 'original uploadObject performs the POST upload');
    const patchedCounters = { put: 0, post: 0 };
    const patchedResult = await invoke('uploadObject', patched, {
      sandbox: makeSandbox(patchedCounters),
      thisProps: { objectUploadTimeoutMs: 1000 },
      args: [{ target: { method: 'PUT' }, artifactPath: 'a' }],
    });
    check(total(patchedCounters) === 0, '已补丁 uploadObject 零上传副作用', 'patched uploadObject has zero upload side effects');
    check(patchedResult.ok === false && patchedResult.reason === 'snapshot_upload_disabled', '已补丁 uploadObject 明确返回未上传', 'patched uploadObject explicitly reports no upload');
  }
} catch (e) {
  check(false, '副作用测试发生异常：' + e.message, 'side-effect suite threw: ' + e.message);
}

report('快照补丁副作用计数测试（VM + mock，真实安装只读）', 'Snapshot patch side-effect tests (VM + mocks, real install read-only)', process);
