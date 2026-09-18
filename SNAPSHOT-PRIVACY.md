# 仓库快照采集上传禁用补丁（SNAPSHOT-PRIVACY）

本补丁用于在**用户授权**的前提下，禁用 ZCode 桌面端内置的「仓库快照采集与上传」功能。
它只修改一个归档条目中的五个方法入口，让采集与上传在第一步就返回，不发起任何相关网络请求，
并同步更新该条目的归档完整性元数据。

- 目标文件：`C:/Program Files/ZCode/resources/app.asar`
- 目标条目：`out/host/index.js`
- 适用版本：ZCode `3.12.3`（Electron `41.0.3`）
- 工具：`snapshot-patch.mjs`（独立脚本，无第三方依赖，需要 Node.js 18+）

> 本补丁**只**处理仓库快照的采集与上传通道，不改变模型请求、更新检查、登录、遥测等其他网络功能。
> 它不能撤回或删除此前已经采集/上传的内容，也不保证封堵其他潜在的数据外发通道。详见文末「限制与残余风险」。

---

## 1. 禁用了哪些入口，以及为什么

补丁在下面五个方法体的最前面插入等长的提前返回，因此这些方法被调用时不会执行原有逻辑：

| 方法 | 作用 | 影响范围 |
| --- | --- | --- |
| `RepoSnapshotSidecar.captureBeforePrompt` | 采集入口的公共方法，内部调用 `captureBeforePromptUnsafe` | 覆盖**新采集**：`prompt` 阶段与 `terminal`（任务完成）阶段，以及 repo-wiki 通道 |
| `RepoSnapshotUploadWorker.flushWorkspace` | 刷写指定工作区的待上传队列 | 覆盖**已有 pending** 的刷写 |
| `RepoSnapshotUploadWorker.flushActiveUpload` | 处理单条待上传记录（返回 `false` 终止循环） | 覆盖**已有 pending** 的逐条处理 |
| `RepoSnapshotUploadClient.getUploadCredential` | 获取上传凭据（网络 GET） | 直接阻止凭据请求 |
| `RepoSnapshotUploadClient.uploadObject` | 上传制品（PUT/POST） | 最后一道防线，直接拒绝上传 |

调用链核对结果（基于真实归档内容）：

- 主对话路径与 repo-wiki 路径都通过 `repoSnapshotSidecar.captureBeforePrompt` 进入；
- `captureBeforePromptUnsafe` 只有 `captureBeforePrompt` 一个调用方；
- `getUploadCredential` 只有 `getUploadKey` 一个调用方，后者在凭据为空时直接返回 `null`；
- `uploadObject` 只有一个调用方（`flushActiveUpload` 内部）；
- 采集阶段字面量只有 `prompt` 与 `terminal`，两者都经过被禁用的公共方法，因此任务完成路径同样被覆盖。

## 2. 版本签名与哈希证据

工具只接受与下列签名完全匹配的文件，否则拒绝修改（`Unknown host signature` / `Unknown host SHA256`）：

| 项目 | 值 |
| --- | --- |
| `app.asar` 大小 | `307867744` 字节 |
| 头部前四个 uint32LE | `4, 7013000, 7012996, 7012990` |
| 数据区起点 | `7013008`（= `8 + uint32LE(4)`） |
| 主机条目 `offset` / `size` | `"244037758"` / `2588119` |
| 主机条目原始 SHA-256 | `c8f7b2e50f2c8f7eeb030a377cfc4779b2a0e2037af2239e065157dc2e3e422e` |
| 主机条目打补丁后 SHA-256 | `5b356cbaf445315bd6421457caafe98e116ebe626513616a1d0b47bc30e5d033` |
| 整个 `app.asar` 原始 SHA-256 | `47555330451964630b14950ce7dd496a33102ecf281d251900fe7c73252fbc7e` |

关于 ASAR 布局的一个重要细节：数据区起点是 `8 + uint32LE(4)`。
**不能**用 `16 + 头部 JSON 长度`：真实文件的 JSON 长度为 `7012990`，其 pickle 需要补 2 字节对齐，
`16 + 7012990 = 7013006` 是错的，正确值是 `7013008`。工具在解析时会同时校验

```
uint32(0) == 4
uint32(8) == 4 + align4(uint32(12))     // pickle 负载 = 4 字节长度 + JSON + 对齐填充
uint32(4) == 4 + uint32(8)              // 头部区域大小
8 + uint32(4) == align4(16 + uint32(12))
```

任一条不满足即拒绝操作。

## 3. 修改方式与完整性处理

- **原位等长替换**：五个方法被替换为「签名前缀 + 注释填充 + 提前返回」，替换体与原始方法**字节长度完全相同**。
  因此归档中该条目的 `size`、`offset` 以及头部长度都不变，其他条目的偏移量不受影响。
- **只更新一个条目的完整性元数据**：重新计算 `out/host/index.js` 的
  `integrity = { algorithm, hash, blockSize, blocks }`（`blockSize` 与块数保持原样，仅哈希更新）。
- **不动其他条目**：深度验证会逐个读取全部非 unpacked 条目并校验其整文件哈希与每个分块的哈希，
  还会检查条目偏移不重叠、不越界。在真实归档上共校验 `26773` 个条目，跳过 `12` 个未打包条目。
- **零填充文件**：大小为 0 的条目在真实归档中仍有 1 个分块（空内容的哈希），工具与之一致。
- **备份与回滚**：写入前先在同目录生成
  `app.asar.snapshot-privacy.header.bak`（头部区域）、
  `app.asar.snapshot-privacy.host.bak`（主机条目原文）与
  `app.asar.snapshot-privacy.receipt.json`（含前后哈希与备份哈希的收据）。
  回滚必须通过收据与备份哈希校验；目标被外部改动时拒绝回滚。
- **并发保护**：写入前会重新计算整个归档的 SHA-256，若与读取时不一致则中止并清理刚创建的备份。
- **幂等**：重复 `apply` 会识别已补丁状态并返回 `already-applied`，不会重复写入。

## 4. Electron 可执行文件的融合开关与内嵌完整性

工具会检查同级目录的 `ZCode.exe`，并在 `check` / `verify` 输出中报告结论。实测（ZCode 3.12.3 / Electron 41.0.3）：

| 检查项 | 实测结果 |
| --- | --- |
| 融合开关（fuse wire） | 版本 `1`，共 `9` 项，状态串 `101100011` |
| `EnableEmbeddedAsarIntegrityValidation`（第 4 项，索引从 0 起） | `0`，即**关闭** |
| `ELECTRONASAR` 资源 | 存在，`alg=SHA256`，`value=af904d14…`，`file=resources\app.asar` |
| 阻断风险判定 | `none`（因为融合开关关闭，内嵌校验不会执行） |

补充说明：`af904d14…` 与当前归档头部在多种标准定义下（原始头部 JSON、`[8, dataStart)` 头部区域、
整个文件等）**都不匹配**。这与融合开关关闭一致：该资源当前是惰性的。
融合开关列表在 Electron 中是**只追加**的，因此第 4 项始终是 `EnableEmbeddedAsarIntegrityValidation`。

工具的处置策略：

- 融合开关关闭 → 判定为无阻断风险，正常继续；
- 融合开关启用且内嵌哈希与当前头部匹配 → 判定为 `blocking`，**拒绝 apply**（因为改头部会导致校验失败、应用无法启动）；
- 融合开关启用但哈希无法匹配 → 判定为 `uncertain`，默认拒绝，只有显式传入
  `--accept-embedded-integrity-risk` 才会继续。

本次交付**没有**修改 `ZCode.exe`，也没有修改任何签名或校验开关。

## 5. 命令

需要管理员权限（Program Files 写入）。所有命令都不会启动、关闭或重启 ZCode。

```powershell
npm run snapshot:check      # 只读检查：版本签名、完整性、融合开关与内嵌完整性风险
npm run snapshot:apply      # 应用补丁（需 --confirm，脚本已内置）
npm run snapshot:verify     # 深度验证：全部条目逐块完整性 + 归档哈希 + 收据一致性
npm run snapshot:rollback   # 回滚到打补丁前状态（需 --confirm）
npm run test:snapshot       # 离线测试（逻辑 / 端到端 / 副作用计数）
npm run test:snapshot:real  # 可选，重型：把真实 app.asar 复制到临时目录做完整 apply/verify/rollback
```

Makefile 等价目标：`make snapshot-check`、`make snapshot-apply`、`make snapshot-verify`、
`make snapshot-rollback`、`make test-snapshot`、`make test-snapshot-real`。

`snapshot-check` 的典型输出（真实安装、未打补丁）：

```text
仓库快照采集上传禁用补丁：安装检查
文件：C:/Program Files/ZCode/resources/app.asar
主机条目：out/host/index.js
主机 SHA256：c8f7b2e50f2c8f7eeb030a377cfc4779b2a0e2037af2239e065157dc2e3e422e
条目完整性：自洽
状态：待修复（PATCHABLE）
电子封装检查：
- 融合开关版本 1，共 9 项。
- EnableEmbeddedAsarIntegrityValidation = 0（1 为启用，0 为关闭）。
- 可执行文件内嵌 app.asar 完整性记录：存在。
- 阻断风险评估：none（EnableEmbeddedAsarIntegrityValidation fuse is disabled）。
```

`snapshot-verify` 在真实未打补丁安装上的实测输出（只读）：

```text
已校验条目：26773 个（跳过未打包条目 12 个）。
整个 ASAR SHA256：47555330451964630b14950ce7dd496a33102ecf281d251900fe7c73252fbc7e
结果：未通过。
- host bundle is not patched (status: patchable)
```

这条「未通过」是预期的：安装尚未打补丁。

> 该补丁**本次交付没有应用到真实安装**。若你决定应用，需要自行用管理员权限运行上述命令。

## 6. 生效方式

改动写入磁盘后，**必须完全退出 ZCode 并重新启动**才会生效。
仅关闭窗口或重新加载页面不一定能卸载已加载到内存中的旧代码。
本工具不会结束进程，也不会自动重启应用。

## 7. 限制与残余风险

- **范围有限**：只禁用仓库快照采集/上传的五个入口。其他网络功能（模型请求、登录、更新检查、
  其他产品特性、诊断/遥测等）完全不变，也不在其覆盖范围内。
- **不保证封堵其他泄漏通道**：本补丁不审计也不阻止其他可能的数据外发路径。
- **历史无法召回**：此前已经采集或上传的仓库快照无法通过本补丁撤回、删除或使其失效；
  服务端保留策略不在本工具影响范围内。
- **本地残留**：补丁停止新的采集与上传处理，但不会删除磁盘上已存在的本地快照/待上传文件。
- **版本敏感**：ZCode 升级会替换 `app.asar`，需要重新检查并重新应用。任何与已知签名不符的文件都会被拒绝。
- **回滚前提**：需要备份与收据。工具支持恢复写入中断的状态，但必须证明两个补丁区域之外的字节与原归档一致；区域外改动或文件长度变化会被拒绝。最终归档预期哈希在修改之前写入收据。
- **验证基线**：`verify` 要求收据存在，并匹配已补丁归档的整档哈希；缺少收据不会报告验证通过。
- **备份内容**：备份文件包含原始主机代码片段与头部区域，位于 Program Files 内，请勿随意外传或提交。
- **融合开关的残余不确定性**：工具按 Electron「只追加」的融合开关顺序读取第 4 项，并始终打印原始状态串，
  便于人工复核；若未来构建启用了内嵌完整性且其哈希与头部匹配，apply 会被拒绝。
- **不执行真实宿主**：所有测试都不运行 ZCode 主程序，只做离线解析、VM 模拟与合成归档验证。

## 8. 测试实际结果（2026-09-18）

```text
node --check snapshot-patch.mjs                      通过
node --check test-snapshot.mjs                       通过
node --check tests/*.mjs                             通过

npm run test:snapshot                                全部通过
  - 补丁逻辑：原位等长替换、ASAR 头部几何、融合开关与内嵌完整性判定    通过
  - 端到端：合成 ASAR 上的 apply/verify/rollback、未知签名、外部改动与备份损坏拒绝  通过
  - 副作用计数：真实方法的原始版本触发 mock，已补丁版本零副作用        通过

node tests/test-snapshot-real-copy.mjs               全部通过（18 秒）
  - 真实副本 apply 成功（5 个入口）；逐条目完整性校验 26773 个通过；
    重复 apply 幂等；回滚后整个 ASAR 逐字节还原。

node snapshot-patch.mjs verify（真实安装，只读）      预期「未通过：尚未打补丁」
  - 26773 个条目完整性全部通过；归档 SHA256 47555330…
```

副作用计数（VM + mock）覆盖的路径与结果：

- 原始 `captureBeforePrompt`：在 `prompt` 与 `terminal`（任务完成）两种阶段都会调度采集 → mock 计数 1/1；
  已补丁版本 → 计数 0。
- 原始 `flushWorkspace`：触发刷写循环 → 计数 1；已补丁版本 → 计数 0。
- 原始 `flushActiveUpload`：读取并处理待上传记录 → 计数 4（read/token/attempt/discard）；已补丁版本 → 计数 0，返回 `false`。
- 原始 `getUploadCredential`：发起凭据请求 → 计数 1；已补丁版本 → 计数 0，返回 `null`。
- 原始 `uploadObject`：PUT 与 POST 均触发上传 → 计数 1；已补丁版本 → 计数 0，返回
  `{ ok:false, reason:'snapshot_upload_disabled' }`。

---

## English summary

This patch disables ZCode's built-in repository snapshot capture/upload, on explicit user authorization,
by inserting equal-length early returns into five methods of the single ASAR entry `out/host/index.js`
inside `C:/Program Files/ZCode/resources/app.asar`:

- `RepoSnapshotSidecar.captureBeforePrompt` (covers new captures from both the `prompt` and the
  `terminal`/task-complete stages, and the repo-wiki path),
- `RepoSnapshotUploadWorker.flushWorkspace` and `flushActiveUpload` (cover already pending uploads),
- `RepoSnapshotUploadClient.getUploadCredential` (no credential network GET),
- `RepoSnapshotUploadClient.uploadObject` (no artifact PUT/POST).

Because the replacements are byte-length equal, the entry size/offset and the archive header geometry are
unchanged; only that entry's `integrity.hash`/`blocks` are recomputed. Every other entry keeps its original
bytes and integrity metadata (verified for all 26,773 entries of the real archive).

Version signature (ZCode 3.12.3, Electron 41.0.3): host entry offset `"244037758"`, size `2588119`,
original SHA-256 `c8f7b2e5…`, patched SHA-256 `5b356cba…`. Unknown files are refused. The ASAR data area
starts at `8 + uint32LE(4)` = `7013008`; note that `16 + JSON length` would be wrong by the two padding bytes.

Electron packaging check: the fuse wire has version 1 and 9 entries with states `101100011`, so
`EnableEmbeddedAsarIntegrityValidation` (index 4, fuses are append-only) is **disabled**; the
`ELECTRONASAR` resource exists but its value does not match the current header under any standard
definition, and it is inert. The tool refuses to apply if a future build enables that fuse and its embedded
hash matches the header, and requires an explicit flag when the situation is uncertain. `ZCode.exe` itself
is never modified.

Commands: `npm run snapshot:check|apply|verify|rollback`, `npm run test:snapshot`,
`npm run test:snapshot:real` (heavier, copies the real archive into a temp directory).
A full quit and restart of ZCode is required for the change to take effect; the tool never starts, stops or
restarts the application. The real installation was **not** modified during this delivery.

Limitations: the patch only covers repository snapshot capture/upload; it does not audit or block other
data-egress channels, cannot recall or delete previously collected/uploaded snapshots, does not delete
local snapshot artifacts, must be re-applied after a ZCode update, and rollback requires intact backups
and an unmodified archive.
