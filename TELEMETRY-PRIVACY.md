# 遥测与额外上报禁用补丁（Telemetry / extra-report privacy patch）

针对 Windows ZCode 3.12.3 的可检查、可备份、可回滚补丁。它直接禁用 ZCode 自己的额外上报
（事件上报、ARMS RUM 遥测、模型/Agent OTLP 轨迹），同时保留正常模型请求与用户主动的网络操作。

分析与证据见 [REPORT-TELEMETRY-UPLOAD.md](REPORT-TELEMETRY-UPLOAD.md)；测试记录见 [TEST-RESULTS.md](TEST-RESULTS.md)。

## 1. 它会做什么

对 `app.asar` 中 4 个主进程条目做 6 处**原位等长替换**，并对 ASAR 之外的 Agent 包
`resources/glm/zcode.cjs` 做 1 处硬阻断；不改变条目大小、偏移或 ASAR 头部几何：

| 条目 | 修改 | 效果 |
| --- | --- | --- |
| `out/main/index.js` | `mi.init({enable:!0…})` → `enable:!1` | 关闭 ARMS RUM 采集与渲染进程注入 |
| `out/main/index.js` | `Ww(...)` 导出器创建分支不可达 | 主进程不再创建 OTLP trace 导出器 |
| `out/main/chunk-6XM33EZR.js` | ARMS RUM 端点 URL → 等长空白 | 即使有自定义事件也无上报地址 |
| `out/main/chunk-HW54O52P.js` | 事件上报传输 `sendReportAttempt` 立即返回 | 会话/用量事件上报零网络 |
| `out/main/chunk-DBVOEQ2Z.js` | 打包 OTLP 端点 → 等长空白 | host/Agent 不再初始化模型轨迹遥测 |
| `out/main/chunk-DBVOEQ2Z.js` | 打包 OTLP 头（含 `x-arms-license-key`）→ 等长空白 | 移除打包上报密钥 |
| `resources/glm/zcode.cjs` | Agent 共用入口 `H4n` 立即 `return e` | 硬阻断 Agent 遥测，抗 `.env` 绕过 |

同时更新被修改 ASAR 条目的完整性信息，并写入备份与收据。`H4n` 是 Agent 侧唯一调用 `a_s`（唯一创建
OTLP trace/metric 运行时）的入口，因此一处硬阻断即可关闭全部 Agent 导出器。

## 2. 它不会做什么

- **不**修改模型请求、provider 配置、API Key 或模型参数；
- **不**禁止应用整体联网：登录、计费、插件市场、自动更新、会话分享、用户主动反馈日志上传、
  MCP 与用户工具（Telegram/飞书/企业微信等）都保留；
- **不**删除本地崩溃转储或本地诊断日志；
- **不**撤回已上传的数据；
- **不**修改 `ZCode.exe`；
- **不**修改 `resources/glm/zcode.cjs`（Agent 模型遥测通过打包环境置空来禁用）。

## 3. 适用版本与签名

| 项目 | 值 |
| --- | --- |
| 应用版本 | `3.12.3`（Electron `41.0.3`） |
| 头部几何 | `dataStart=7013008`，`jsonLen=7012990` |
| 融合开关 | `EnableEmbeddedAsarIntegrityValidation=0`（关闭），阻断风险 `none` |
| 目标条目 | `out/main/index.js`、`out/main/chunk-6XM33EZR.js`、`out/main/chunk-HW54O52P.js`、`out/main/chunk-DBVOEQ2Z.js` |

每个目标条目的 offset/size/SHA256 都被钉住；任何不匹配（包括未知版本或已被其他工具改动）都会**拒绝修改**。

## 4. 命令

需要 Windows 与 Node.js 18+，无第三方依赖。

```powershell
npm run telemetry:check      # 只读：ASAR + CLI 两个上报面的签名/状态/完整性/崩溃 fail-closed 检查
npm run telemetry:apply      # 写入：一键覆盖两个上报面，需要管理员权限（Program Files）
npm run telemetry:verify     # 只读：两个上报面的完整性 + 收据基线
npm run telemetry:rollback   # 写入：按 LIFO（先 CLI 后 ASAR）恢复
```

一键命令由 `telemetry-all.mjs` 驱动，**同时覆盖 ASAR 面与 CLI（`glm/zcode.cjs`）面**，分项输出状态；
任一上报面失败时返回非零，且已写入的备份不会被删除。只想处理单个上报面时可用：

```powershell
npm run telemetry:apply:asar   / telemetry:verify:asar
npm run telemetry:apply:agent  / telemetry:verify:agent
```

也可以直接指定目标：

```powershell
node telemetry-all.mjs check "C:/Program Files/ZCode/resources/app.asar" "C:/Program Files/ZCode/resources/glm/zcode.cjs"
node telemetry-all.mjs apply --confirm
```

`apply` 与 `rollback` 必须显式传入 `--confirm`。当融合开关启用且内嵌完整性可能阻断时，需要额外的
`--accept-embedded-integrity-risk`（当前版本不需要）。

**应用后必须完全退出并重新启动 ZCode** 才会加载新代码。脚本不会终止进程、不会删除备份。

## 5. 备份与回滚

```
<app.asar>.telemetry-privacy.header.bak
<app.asar>.telemetry-privacy.entry.<entry>.bak
<app.asar>.telemetry-privacy.receipt.json
resources/glm/zcode.cjs.telemetry-privacy.bak
resources/glm/zcode.cjs.telemetry-privacy.receipt.json
```

- 备份与收据在写入前落盘，ASAR 收据已包含最终 `after` 哈希，因此中断的 apply 不会留下空收据；
- ASAR 回滚校验每个备份的 SHA256、目标大小、以及「区域外字节仍等于补丁前归档」；
- Agent 文件回滚**只重写 `H4n` 变更区域**，并要求「用备份区域替换后整档哈希等于补丁前哈希」才允许恢复，
  因此区域外改动或尺寸变化会被拒绝，区域内的半截写入可安全恢复；
- 只有在能证明未发生无关外部改动时才执行破坏性恢复，否则拒绝；
- 回滚成功后自动清理备份与收据，文件逐字节还原（真实副本测试已验证）。

## 6. 覆盖与残余限制

**已核实覆盖**（补丁后零网络）：事件上报 `zcode.z.ai/api/v1/event/report`、ARMS RUM `…/rum/web/v2`、
模型/Agent OTLP `…/apm/trace/opentelemetry`、Agent 遥测硬阻断（有效端点 + `ZCODE_MODEL_TELEMETRY_ENABLED=true`
下仍零初始化）、主进程渲染动作 trace 导出器。

**明确保留**：模型请求、OAuth/登录、计费、插件市场、自动更新、用户主动分享、用户主动反馈日志上传、
用户工具端点、本地崩溃归档与本地诊断日志。

**残余限制**：

1. `.env` 中配置 `OTEL_EXPORTER_OTLP_*` 已不再能启用 Agent 遥测：`H4n` 硬阻断在有效端点 + 开关 `true/1/on`
   下仍零初始化（已用真实提取函数 + mock 证明）。本补丁只阻断共用入口，`a8t`/`b_s`/`a_s` 保持原样；
   若未来版本新增不经 `H4n` 的入口，需重新审计。
2. 提示词/会话正文是否曾被上报**未获证实**：事件上报的 `event_text` 为 UI 事件名、OTLP 属性为模型元数据；
   本补丁禁用已确认的额外上报路径，**是否存在其他未知外发通道不做保证**。
3. 崩溃远程上报：**静态证据未发现**远程 `crashReporter.start`（仅本地 `uploadToServer:!1`），并由只读
   fail-closed 检查持续把关；Crashpad handler 二进制自身行为未动态验证，不能据静态结论断言任何情况下都无远程上传。
4. 渲染进程为静态 URL 审计，未做运行时抓包。
5. 升级 ZCode 后需重新检查适用性（工具会拒绝未知版本）。
6. 不撤回已上传数据；运行中进程仍使用旧代码，需重启。

## 7. 与快照补丁组合

三个补丁（快照、遥测 ASAR、遥测 Agent 文件）可独立选择。遥测的 ASAR 面与快照补丁都会重写同一个 ASAR 头部：

- 两种应用顺序（先快照后遥测 / 先遥测后快照）都能成功 apply 与 verify；
- ASAR 面回滚必须 **LIFO**（后应用的先回滚）；乱序回滚会被拒绝且不破坏归档；
- 当另一个补丁在之后应用时，先应用补丁的 `verify` 会因归档哈希基线变化而报
  `archive hash does not match the receipt` —— 这是预期交互。请在每次 apply 后立即 verify，
  或按 LIFO 回滚后再 verify。
- 遥测的 Agent 文件面（`glm/zcode.cjs`）是独立文件、独立备份，与 ASAR 面及快照补丁互不影响；
  `npm run telemetry:rollback` 按 LIFO 先回滚 Agent 面再回滚 ASAR 面。

## 8. English summary

This patch disables ZCode's own extra uploads on Windows ZCode 3.12.3: the event-report transport
(`zcode.z.ai/api/v1/event/report`), ARMS RUM telemetry (`…/rum/web/v2`), and the packaged
OpenTelemetry model/agent trace export (`…/apm/trace/opentelemetry`). It edits four `out/main`
entries with six byte-for-byte equal-length replacements, updates their ASAR integrity metadata, and
writes integrity-checked backups and a receipt. Normal model requests, login, billing, plugin
marketplace, auto-update, user-initiated sharing/feedback, MCP and user tools are untouched.

Commands: `npm run telemetry:check | telemetry:apply | telemetry:verify | telemetry:rollback`.
A full quit and restart of ZCode is required after applying. Unknown versions are refused. Residual
limits: an `OTEL_EXPORTER_OTLP_*` value in a local `.env` can re-enable the agent-side trace export
(set `ZCODE_MODEL_TELEMETRY_ENABLED=false` as well); no active remote crash-upload path was found, so
none is blocked; already-uploaded data is not recalled.
