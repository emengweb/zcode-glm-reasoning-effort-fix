// Suite 1: pure logic of the snapshot privacy patch (no file mutation).
import fs from 'node:fs';
import path from 'node:path';
import { check, report, tempDir, cleanup, assert, assertEqual, assertThrows } from './helpers.mjs';
import { buildFixture, hostFixtureText } from './fixture-asar.mjs';
import {
  hash, countOccurrences, transformHost, buildPatched, patchedAnchor, PATCHES,
  parseHeaderBuffers, readAsarHeader, getEntry, readEntryBuffer, verifyIntegrityBlocks,
  expectedBlocks, blockHashes, parseFuseWire, FUSE_WIRE_MAGIC, FUSE_NAMES, inspectExecutable,
  align4, KNOWN_VERSION, HOST_ENTRY_PATH, apply,
} from '../snapshot-patch.mjs';

const dir = tempDir('zcode-snap-logic-');
try {
  // --- transform -----------------------------------------------------------
  const hostText = hostFixtureText();
  const originalCount = PATCHES.reduce((n, p) => n + countOccurrences(hostText, p.original), 0);
  check(originalCount === 5, '夹具中包含全部 5 个原始方法且各出现一次', 'fixture contains all five original methods exactly once');

  for (const spec of PATCHES) {
    const patched = buildPatched(spec);
    check(patched.length === spec.original.length, `${spec.id} 替换体与原始方法等长`, `${spec.id} replacement is byte-length equal`);
    check(patchedAnchor(spec) && typeof patchedAnchor(spec) === 'string', `${spec.id} 标记可识别`, `${spec.id} marker is detectable`);
  }

  const first = transformHost(hostText);
  const patchedBuf = Buffer.from(first.text, 'utf8');
  check(first.changed === true && first.applied.length === 5, '首次变换应用全部 5 个补丁', 'first transform applies all five patches');
  check(patchedBuf.length === Buffer.byteLength(hostText), '变换后字节长度不变', 'transformed byte length is unchanged');
  const second = transformHost(first.text);
  check(second.changed === false && second.already.length === 5, '重复变换幂等（识别为已打补丁）', 'repeat transform is idempotent (detected as already patched)');
  check(second.text === first.text, '幂等变换不改变字节', 'idempotent transform leaves bytes identical');

  // Tampered signature must be refused.
  const tampered = hostText.replace('reason:"object_upload_failed"', 'reason:"object_upload_failXX"');
  check(tampered !== hostText, '篡改样本已构造', 'tampered sample constructed');
  assertThrows(() => transformHost(tampered), /Unknown host signature/, 'tampered host must be refused');
  check(true, '未知方法签名被拒绝修改', 'unknown method signature is refused');

  // Duplicate signature must be refused (ambiguous).
  const duplicated = hostText + '\n' + PATCHES.find(p => p.id.endsWith('uploadObject')).original;
  assertThrows(() => transformHost(duplicated), /Unknown host signature/, 'duplicated method must be refused');
  check(true, '重复方法签名（歧义）被拒绝修改', 'duplicated method signature (ambiguous) is refused');

  assertEqual(countOccurrences('aaaa', 'aa'), 2, 'countOccurrences counts overlaps');
  check(true, 'countOccurrences 非重叠计数正确', 'countOccurrences counts non-overlapping matches');

  // --- header layout -------------------------------------------------------
  const fixture = buildFixture(dir);
  const meta = readAsarHeader(fixture.asarPath);
  check(meta.dataStart === fixture.dataStart && meta.jsonLen === fixture.jsonLen, '头部几何与夹具一致', 'header geometry matches the fixture');
  check(meta.dataStart === 8 + meta.headerSize, '数据区起点 = 8 + uint32(4)', 'data start = 8 + uint32(4)');
  check(meta.dataStart === align4(16 + meta.jsonLen), '数据区起点 = 16 + JSON 长度对齐后', 'data start = aligned(16 + JSON length)');
  check(meta.dataStart !== 16 + meta.jsonLen, '未误用 16 + JSON 长度', 'naive 16 + JSON length is not used');
  fs.closeSync(meta.fd);

  // Prove the unaligned case: a JSON length of 5 must resolve to data start 24.
  const json5 = Buffer.from('[1,2]', 'utf8');
  const pre5 = Buffer.alloc(16);
  pre5.writeUInt32LE(4, 0);
  pre5.writeUInt32LE(16, 4);
  pre5.writeUInt32LE(12, 8);
  pre5.writeUInt32LE(5, 12);
  const parsed5 = parseHeaderBuffers(pre5, json5);
  check(parsed5.dataStart === 24, 'JSON 长度非 4 倍数时按对齐计算数据区起点', 'unaligned JSON length resolves data start by alignment');

  const badPrefix = Buffer.alloc(16);
  badPrefix.writeUInt32LE(4, 0);
  badPrefix.writeUInt32LE(32, 4);
  badPrefix.writeUInt32LE(20, 8);
  badPrefix.writeUInt32LE(40, 12);
  assertThrows(() => parseHeaderBuffers(badPrefix, Buffer.alloc(40)), /Unsupported ASAR layout/, 'bad layout must be rejected');
  check(true, '异常 ASAR 头部布局被拒绝', 'malformed ASAR header layout is rejected');

  // --- integrity blocks ----------------------------------------------------
  const entryMeta = readAsarHeader(fixture.asarPath);
  const entry = getEntry(entryMeta.header, HOST_ENTRY_PATH);
  const hostBuf = readEntryBuffer(entryMeta.fd, entryMeta, entry);
  const good = verifyIntegrityBlocks(entry, hostBuf);
  check(good.ok === true && good.blocks > 1, '主机条目多块完整性自洽', 'host entry multi-block integrity is consistent');
  const mutated = Buffer.from(hostBuf);
  mutated[10] = mutated[10] ^ 0xff;
  check(verifyIntegrityBlocks(entry, mutated).ok === false, '内容被改动时完整性检测失败', 'integrity check fails when content changes');
  const wrongBlocks = { ...entry, integrity: { ...entry.integrity, blocks: expectedBlocks(hostBuf, 999999) } };
  check(verifyIntegrityBlocks(wrongBlocks, hostBuf).ok === false, '块大小不符时完整性检测失败', 'integrity check fails on block-size mismatch');
  const emptyBlocks = blockHashes(Buffer.alloc(0), 4194304);
  check(emptyBlocks.length === 1 && emptyBlocks[0] === hash(Buffer.alloc(0)), '空文件按真实归档约定产生 1 个块', 'zero-byte file yields exactly one block, as the real archive stores');
  fs.closeSync(entryMeta.fd);

  // --- fuse wire -----------------------------------------------------------
  const wire = Buffer.concat([
    Buffer.from(FUSE_WIRE_MAGIC, 'ascii'),
    Buffer.from([1, 9]),
    Buffer.from('101100011', 'latin1'),
    Buffer.alloc(5),
  ]);
  const fuse = parseFuseWire(wire, 0);
  check(fuse.version === 1 && fuse.count === 9, '融合开关版本与数量解析正确', 'fuse version and count parsed correctly');
  check(fuse.named.EnableEmbeddedAsarIntegrityValidation === '0', '融合开关条目名映射正确', 'fuse entry names map correctly');
  check(FUSE_NAMES.length === 8, '已知融合开关名称数量为 8（第 9 项为新增项）', 'eight known fuse names (ninth is an appended fuse)');
  assertThrows(() => parseFuseWire(Buffer.alloc(4), 0), /Fuse wire/, 'short wire must be rejected');
  check(true, '过短的融合开关数据被拒绝', 'truncated fuse wire is rejected');

  // --- synthetic PE with ELECTRONASAR + fuse ---------------------------------
  function buildFakeExe(file, states, value, options = {}) {
    const json = Buffer.from(JSON.stringify([{ file: 'resources\\app.asar', alg: 'SHA256', value }]), 'utf8');
    const ROOT = 0, NAME1 = 24, L1 = 44, NAME2 = 68, L2 = 94, DATAENTRY = 118;
    const dataOff = align4(118 + 16);
    const sectionSize = dataOff + json.length;
    const rsrc = Buffer.alloc(align4(sectionSize));
    rsrc.writeUInt32LE(0, ROOT + 4);
    rsrc.writeUInt16LE(1, ROOT + 12);
    rsrc.writeUInt32LE((0x80000000 | NAME1) >>> 0, ROOT + 16);
    rsrc.writeUInt32LE((0x80000000 | L1) >>> 0, ROOT + 20);
    const n1 = 'INTEGRITY';
    rsrc.writeUInt16LE(n1.length, NAME1);
    rsrc.write(n1, NAME1 + 2, 'utf16le');
    rsrc.writeUInt16LE(1, L1 + 12);
    rsrc.writeUInt32LE((0x80000000 | NAME2) >>> 0, L1 + 16);
    rsrc.writeUInt32LE((0x80000000 | L2) >>> 0, L1 + 20);
    const n2 = 'ELECTRONASAR';
    rsrc.writeUInt16LE(n2.length, NAME2);
    rsrc.write(n2, NAME2 + 2, 'utf16le');
    rsrc.writeUInt16LE(1, L2 + 14);
    rsrc.writeUInt32LE(1033, L2 + 16);
    rsrc.writeUInt32LE(DATAENTRY, L2 + 20);
    rsrc.writeUInt32LE(0x1000 + dataOff, DATAENTRY);
    rsrc.writeUInt32LE(json.length, DATAENTRY + 4);
    json.copy(rsrc, dataOff);

    const rawOffset = 0x200;
    const total = rawOffset + rsrc.length;
    const fileBuf = Buffer.alloc(total);
    fileBuf.writeUInt16LE(0x5a4d, 0);
    fileBuf.writeUInt32LE(0x40, 0x3c);
    fileBuf.write('PE\u0000\u0000', 0x40, 'latin1');
    fileBuf.writeUInt16LE(0x8664, 0x44);
    fileBuf.writeUInt16LE(1, 0x46);
    fileBuf.writeUInt16LE(240, 0x44 + 16);
    const opt = 0x58;
    fileBuf.writeUInt16LE(0x20b, opt);
    fileBuf.writeUInt32LE(0x1000, opt + 112 + 2 * 8);
    fileBuf.writeUInt32LE(rsrc.length, opt + 112 + 2 * 8 + 4);
    const sec = opt + 240;
    fileBuf.write('.rsrc', sec, 'latin1');
    fileBuf.writeUInt32LE(rsrc.length, sec + 8);
    fileBuf.writeUInt32LE(0x1000, sec + 12);
    fileBuf.writeUInt32LE(rsrc.length, sec + 16);
    fileBuf.writeUInt32LE(rawOffset, sec + 20);
    rsrc.copy(fileBuf, rawOffset);
    fs.writeFileSync(file, Buffer.concat([fileBuf, wire.subarray(0, 32), Buffer.from([1, 9]), Buffer.from(states, 'latin1'), Buffer.alloc(5)]));
    if (options.malformed) {
      // Optional-header size far past EOF: the section table cannot be parsed,
      // so the embedded resource cannot be read at all.
      const f = fs.openSync(file, 'r+');
      const two = Buffer.alloc(2);
      two.writeUInt16LE(0x2000, 0);
      fs.writeSync(f, two, 0, 2, 0x54);
      fs.closeSync(f);
    }
  }

  const headerHashes = { headerJson: hash(Buffer.from(meta.jsonText, 'utf8')), headerRegionFrom8: 'deadbeef' };
  const exeDisabled = path.join(dir, 'disabled.exe');
  buildFakeExe(exeDisabled, '101100011', 'a'.repeat(64));
  const inspectedDisabled = inspectExecutable(exeDisabled, headerHashes);
  check(inspectedDisabled.embedded.present === true && inspectedDisabled.embedded.entries.length === 1, '内嵌 app.asar 完整性资源可解析', 'embedded app.asar integrity resource is parsed');
  check(inspectedDisabled.fuseEnabled === false && inspectedDisabled.assessment.risk === 'none', '融合开关关闭时判定为无阻断风险', 'disabled fuse yields no blocking risk');

  const exeUncertain = path.join(dir, 'uncertain.exe');
  buildFakeExe(exeUncertain, '101110011', 'b'.repeat(64));
  const inspectedUncertain = inspectExecutable(exeUncertain, headerHashes);
  check(inspectedUncertain.fuseEnabled === true && inspectedUncertain.assessment.risk === 'uncertain', '融合开关启用且哈希不匹配时判定为不确定', 'enabled fuse with unmatched hash yields uncertain risk');

  const exeBlocking = path.join(dir, 'blocking.exe');
  buildFakeExe(exeBlocking, '101110011', headerHashes.headerJson);
  const inspectedBlocking = inspectExecutable(exeBlocking, headerHashes);
  check(inspectedBlocking.assessment.risk === 'blocking', '融合开关启用且哈希匹配时判定为阻断', 'enabled fuse with matching hash yields blocking risk');

  // apply must refuse when the embedded integrity would block a header change.
  const fixtureExpected = fixture => {
    const transformed = transformHost(fixture.host.text);
    return {
      ...KNOWN_VERSION,
      appVersion: 'fixture',
      dataStart: fixture.dataStart,
      jsonLen: fixture.jsonLen,
      hostEntryOffset: fixture.host.offset,
      hostEntrySize: fixture.host.size,
      hostOriginalSha256: fixture.host.sha256,
      hostPatchedSha256: hash(Buffer.from(transformed.text, 'utf8')),
    };
  };
  const fixture2 = buildFixture(tempDir('zcode-snap-block-'));
  const transformed2 = transformHost(fixture2.host.text);
  const expected2 = {
    ...KNOWN_VERSION,
    appVersion: 'fixture',
    dataStart: fixture2.dataStart,
    jsonLen: fixture2.jsonLen,
    hostEntryOffset: fixture2.host.offset,
    hostEntrySize: fixture2.host.size,
    hostOriginalSha256: fixture2.host.sha256,
    hostPatchedSha256: hash(Buffer.from(transformed2.text, 'utf8')),
  };
  assertThrows(
    () => apply(fixture2.asarPath, { expected: expected2, exePath: exeBlocking }),
    /Embedded ASAR integrity/,
    'apply must refuse a blocking embedded-integrity setup'
  );
  check(true, '内嵌完整性阻断时 apply 拒绝写入', 'apply refuses to write when embedded integrity would block');
  cleanup(path.dirname(fixture2.asarPath));

  // A resource that cannot be parsed must fail closed (uncertain), not "none":
  // an unparsable PE previously looked like "no embedded integrity at all".
  const exeMalformed = path.join(dir, 'malformed.exe');
  buildFakeExe(exeMalformed, '101110011', 'c'.repeat(64), { malformed: true });
  const inspectedMalformed = inspectExecutable(exeMalformed, headerHashes);
  check(inspectedMalformed.fuseEnabled === true, '畸形 PE 的融合开关仍能解析（校验为启用）', 'fuse still parses as enabled on the malformed PE');
  check(!!inspectedMalformed.embeddedError, '畸形 PE 的内嵌资源解析失败被记录', 'malformed PE records an embedded-resource parse error');
  check(inspectedMalformed.assessment.risk === 'uncertain', '资源解析失败时判定为不确定（fail closed）', 'unparsable resource yields uncertain risk (fails closed)');

  // The uncertain assessment must block apply by default and pass with the flag.
  const fixture3 = buildFixture(tempDir('zcode-snap-uncertain-'));
  const expected3 = fixtureExpected(fixture3);
  assertThrows(
    () => apply(fixture3.asarPath, { expected: expected3, exePath: exeUncertain }),
    /Embedded ASAR integrity/,
    'apply must refuse an uncertain embedded-integrity setup without the flag'
  );
  check(true, '内嵌完整性不确定时 apply 默认拒绝写入', 'apply refuses an uncertain embedded-integrity setup by default');
  const appliedUncertain = apply(fixture3.asarPath, { expected: expected3, exePath: exeUncertain, acceptEmbeddedIntegrityRisk: true });
  check(appliedUncertain.status === 'applied' && appliedUncertain.patches.length === 5, '显式接受风险后 apply 可以写入', 'apply proceeds once the risk is explicitly accepted');

  const fixture4 = buildFixture(tempDir('zcode-snap-malformed-'));
  const expected4 = fixtureExpected(fixture4);
  assertThrows(
    () => apply(fixture4.asarPath, { expected: expected4, exePath: exeMalformed }),
    /Embedded ASAR integrity/,
    'apply must refuse when the embedded resource cannot be parsed'
  );
  const appliedMalformed = apply(fixture4.asarPath, { expected: expected4, exePath: exeMalformed, acceptEmbeddedIntegrityRisk: true });
  check(appliedMalformed.status === 'applied', '畸形 PE 场景在显式确认后可写入', 'malformed-PE scenario can proceed with explicit confirmation');
  cleanup(path.dirname(fixture3.asarPath));
  cleanup(path.dirname(fixture4.asarPath));
} catch (e) {
  check(false, '逻辑测试发生异常：' + e.message, 'logic suite threw: ' + e.message);
}

cleanup(dir);
report('快照补丁逻辑测试（离线，临时目录）', 'Snapshot patch logic tests (offline, temp dir)', process);
