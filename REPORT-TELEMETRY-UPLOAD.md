# ZCode 遥测与额外上报分析报告（3.12.3）

本报告记录 ZCode 3.12.3（Windows 打包版，Electron 41.0.3）中与「遥测、诊断、崩溃、会话/提示词额外上报」相关的
真实代码路径、触发条件、发送内容、阻断点与证据边界。分析只读，未修改真实安装。

配套补丁与操作说明见 [TELEMETRY-PRIVACY.md](TELEMETRY-PRIVACY.md)；测试记录见 [TEST-RESULTS.md](TEST-RESULTS.md)。

## 1. 结论摘要

- 在本机 3.12.3 打包版本中，**确认存在**三类由 ZCode 自己发起的额外上报：
  1. **ZCode 事件上报**（应用启动、日活、远端会话用量事件）→ `https://zcode.z.ai/api/v1/event/report`；
  2. **ARMS RUM 遥测**（`@arms/rum-electron` 0.0.3，主进程初始化并注入渲染进程）→ 阿里云 `…/rum/web/v2?…`；
  3. **模型/Agent 轨迹追踪**（OpenTelemetry OTLP，主进程与 `glm/zcode.cjs` Agent 共用打包环境）→ 阿里云 `…/apm/trace/opentelemetry`。
- **静态证据未发现**自动的崩溃远程上报：本版本只有一处 `crashReporter.start`，使用 `uploadToServer:!1` 与不可路由的
  `https://zcode.invalid/local-crash-only`，崩溃转储仅本地归档。这是对应用代码字符串的只读静态结论，**不含对
  Crashpad 二进制的动态验证**，因此不等于证明任何情况下都不存在远程崩溃上传。
- **未发现**自动的诊断日志上传：内存/宿主诊断是本地日志；「反馈日志上传」由用户在反馈流程中主动触发。
- 本补丁禁用了上述 1–3 类额外上报的**传输与采集**，并保留正常模型请求、登录、计费、插件市场、更新、
  用户主动分享与用户主动反馈等业务网络。**已确认的额外上报路径被禁用；是否还有其他未知外发通道不做保证。**

## 2. 版本与归档签名（只读证据）

| 项目 | 值 |
| --- | --- |
| 应用版本 | `3.12.3` |
| Electron | `41.0.3` |
| ASAR 头部整数 | `4, 7013000, 7012996, 7012990` |
| 数据区起点 `dataStart` | `7013008`（= `8 + uint32LE(4)`） |
| 头部 JSON 长度 | `7012990` |
| 融合开关 | 版本 1，9 项，状态串 `101100011`；`EnableEmbeddedAsarIntegrityValidation`（索引 4）= `0`（关闭） |
| 内嵌 ASAR 完整性 | 存在记录但与当前头部不匹配，惰性；融合开关关闭 → 阻断风险 `none` |

被本补丁修改的 4 个条目（偏移/大小/原始 SHA256，均由工具在应用前逐字节校验）：

| 条目 | 偏移 | 大小 | 原始 SHA256（前 16 位） |
| --- | --- | --- | --- |
| `out/main/index.js` | 248945766 | 708140 | `5105c8659924d8c2…` |
| `out/main/chunk-6XM33EZR.js` | 246639402 | 565982 | `71142091b7d289cb…` |
| `out/main/chunk-HW54O52P.js` | 247232047 | 1540045 | `cc3c2b267bf86d7f…` |
| `out/main/chunk-DBVOEQ2Z.js` | 247208693 | 675 | `4ecc6034b1aaf431…` |

## 3. 已确认的上报路径与流程图

### 3.1 ZCode 事件上报（会话/用量事件）

入口模块为 `out/main/chunk-HW54O52P.js` 中的 `createTelemetryCore`（`s(F8,"createTelemetryCore")`），
由 `out/main/index.js` 构造（`Zp({loadUserId, loadMarketingParams, resolveZCodeEndpointOrigin, fetchImpl})`）。
上报负载字段（真实 `ne`/`sendReport` 拼装）：

```
event_id, client_timezone, client_language, element_name, event_region, event_type,
event_text, event_extra_detail, user_id, screen_resolution, app_version,
device_os_category, device_os_version, device_mid, mac_id, marketing_params,
[talk_id], [message_id]        ← talk_id 取 sessionId/parentSessionId
```

**证据边界**：`event_text` 在已观察到的调用中是 UI 元素名/事件名（如 `settings.model…`），`talk_id`/`message_id`
是会话标识符。静态证据**未证实**该通道上传提示词或会话正文；它属于「带会话标识的用量/事件上报」。

```
main 启动 / 日活 / 远端用量事件
        │
        ▼
createTelemetryCore.reportEvent / reportAppLaunch / reportAppDailyActive   (chunk-HW54O52P.js)
        │  组包：event_id、user_id、device_mid、screen_resolution、talk_id/message_id …
        ▼
trackReport(q) ──► sendReport(ne) ──► sendReportAttempt(ie)   ← 唯一的网络调用
        │                                     │  POST https://zcode.z.ai/api/v1/event/report
        │                                     │  （带 2 次重试，408/429/5xx 可重试）
        ▼
完成（本地记录 lastDailyActiveDate 等）

补丁阻断点：sendReportAttempt(ie) 立即返回，不再调用 fetchImpl —— 传输层零网络。
```

### 3.2 ARMS RUM 遥测（主进程 + 渲染进程注入）

`out/main/index.js`：`var ff=mi.init({enable:!0,version:j,endpoint:Ta,env:pi,autoInject:!0,
browserCollectors:{…},collectors:{jsError:!0,consoleError:!0,crash:!0,application:!0,api:!0,rpc:!0},
tracing:{enable:!0,sample:…},beforeReport:…})`。
`Ta` 由 `out/main/chunk-6XM33EZR.js` 的常量 `Dy` 提供（`export{… Dy as s …}` → `import{… s as Ta …}`）：

```
https://proj-xtrace-7e235817c9b9381c22d8b743908d469f-cn-beijing.cn-beijing.log.aliyuncs.com/rum/web/v2?workspace=…&service_id=…
```

```
主进程启动
   │
   ▼
mi.init({enable:!0, endpoint:Ta, autoInject:!0, …})     (main/index.js)
   │
   ├─ 主进程采集器：jsError / consoleError / crash / application / api / rpc / tracing
   ├─ autoInject → 渲染进程注入浏览器 SDK（同一 endpoint 配置）
   └─ 应用自定义事件：dispatchSafely → fi → sendCustom（remote-usage-arms 等）
   │
   ▼
ARMS Reporter.request → fetch(config.endpoint, {method:"POST", …})
   （rum-core/rum-browser reporter：`fetch(e.endpoint, …)`）
```

补丁阻断点：`enable:!0 → enable:!1`（真实 SDK 采集开关 `_` 在 `config.enable===false` 时返回 false，
已用真实 SDK 代码验证），并将 `Dy` 端点字面量置为等长空白 —— 即使有显式 `sendCustom`，`config.endpoint` 也
无法构成可上报 URL。

### 3.3 模型 / Agent 轨迹追踪（OpenTelemetry OTLP）

打包默认环境在 `out/main/chunk-DBVOEQ2Z.js` 中（`export{… p as c …}`）：

```js
var p={OTEL_EXPORTER_OTLP_ENDPOINT:"https://proj-xtrace-…/apm/trace/opentelemetry",
       OTEL_EXPORTER_OTLP_HEADERS:"x-arms-license-key=…,x-arms-project=…,x-cms-workspace=…",
       OTEL_SERVICE_NAME:"zcode-cli-agent",ZCODE_TELEMETRY_RUNTIME_DISTRIBUTION:"packaged"};
```

`main/index.js`：`Fr = Qm()`（`loadHostProcessEnvFromLocalFiles`，无 `.env` 时回退 `resolvePackagedAgentTelemetryEnv(p)`），
随后：
- `spawnHostProcess(..., {hostProcessLocalEnv:Fr, …})` → 传给 host / Agent 进程；
- `Dw({exporter: Ww({...Fr,...process.env}), …})` → 主进程「渲染动作追踪」导出器。

Agent 侧（`resources/glm/zcode.cjs`）真实开关：`H4n(e){ if(!a8t(e) || b_s(e.ZCODE_MODEL_TELEMETRY_ENABLED)) return e; … }`，
其中 `a8t` 解析 OTLP 端点、`b_s` 识别 `"0"/"false"/"off"/"disabled"`。

```
main 启动
   │
   ├─ Fr = 打包 OTLP 环境（端点 + x-arms-license-key）
   │        │
   │        ├─► hostProcessLocalEnv → host → glm/zcode.cjs Agent
   │        │        └─ H4n: 端点存在 → 初始化 OTLP trace（模型轨迹）
   │        └─► Ww({...Fr,...process.env}) → 主进程渲染动作 trace 导出器
   │
   ▼
OTLP HTTP POST → https://proj-xtrace-…/apm/trace/opentelemetry
```

补丁阻断点：将 `OTEL_EXPORTER_OTLP_ENDPOINT` 与 `OTEL_EXPORTER_OTLP_HEADERS` 字面量置为等长空白
（Agent 的 `a8t` 解析为空 → 不初始化），并把主进程 `Ww` 的创建分支改为不可达（`if(t)` → `if(0)`）。

**OTLP 内容属性核查（证据边界）**：对 `glm/zcode.cjs` 中真实 span 属性键的静态审计显示，模型/Agent 追踪使用的是
元数据类属性：`gen_ai.request.model`、`gen_ai.response.model`、`gen_ai.usage.input_tokens/output_tokens`、
`gen_ai.response.finish_reasons`、`zcode.model_attempt.*`（provider/model/token/时长/状态码/请求 id）、
`zcode.agent_turn.*`、`zcode.tool_execution.*`（工具名、输出字节数、截断标志、权限决定）、`zcode.model_call.*`。
**未发现** `gen_ai.prompt`、`gen_ai.completion`、`zcode.prompt`、`zcode.message` 之类的内容型属性键。
因此本报告**不声称** OTLP 通道上传提示词/会话正文被实锤；只能确认它是「模型轨迹元数据」上报。资源属性
（`L4n`）也只含环境、版本、device installation id 等元数据。

### 3.3.1 Agent 遥测硬阻断（glm/zcode.cjs）

打包环境置空可被本地 `.env` 中的 `OTEL_EXPORTER_OTLP_*` 重新注入而绕过。为消除这一依赖，补丁对 Agent 的
**唯一共用初始化入口**做硬阻断：

```
Agent 启动
   │
   ▼
e5e("prepareZCodeTelemetryEnv")  ──►  H4n("prepareModelTelemetryEnv")   ← 唯一入口
                                          │  原条件：!a8t(e) || b_s(ZCODE_MODEL_TELEMETRY_ENABLED)
                                          ▼
                                       a_s("createPreparedOwner")        ← 仅被 H4n 调用
                                          │
                                          ▼
                                       e_s("createOwnedAgentTelemetryRuntime")
                                          │  new OTLPTraceExporter / BatchSpanProcessor /
                                          │  BasicTracerProvider / OTLPMetricExporter /
                                          │  PeriodicExportingMetricReader / MeterProvider
                                          ▼
                                       OTLP HTTP → 阿里云 ARMS
```

补丁把 `H4n` 函数体替换为立即 `return e`（等长原位替换），使 `a_s`/`e_s` 不再被调用：即使端点有效且
`ZCODE_MODEL_TELEMETRY_ENABLED=true/1/on`，Agent 也不创建任何导出器（已用真实提取函数 + mock 证明）。
`a8t`/`b_s` 函数体保持不变，模型请求路径不受影响。

### 3.4 崩溃上报（Crashpad / Electron crashReporter）

全归档只有一处 `crashReporter.start`（`out/main/index.js`）：

```js
!t && !Sm && (Sm=!0, cP.start({companyName:"", productName:…, submitURL:dP, uploadToServer:!1, compress:!0}))
// dP = "https://zcode.invalid/local-crash-only"
```

`initializeCrashCapture(logger, remoteCrashReporterEnabled)` 的调用点是 `var Mm=xm(g,!0)`。
在 `remoteCrashReporterEnabled` 为真时该本地 `start` 被跳过，但**没有发现任何带远程 submitURL 的
`crashReporter.start`**。因此**静态证据未发现**由应用代码建立的崩溃远程上传（`crashDumps` 被 `app.setPath` 指向
本地 staging/archive 目录。

```
进程崩溃 → Electron/Crashpad → 本地 crashDumps staging → 归档到本地 archiveDir（本地文件）
```

**未覆盖/未证实**：Crashpad handler 二进制自身的网络行为未做动态验证；若未来构建启用远程崩溃上报
（出现带真实 submitURL 的 `crashReporter.start`），需要重新审计并新增阻断点。

### 3.5 诊断日志

- 宿主内存诊断：`out/host/index.js` 的 `startHostMemoryDiagnosticsLog` 仅写入本地日志。
- 反馈日志上传：渲染层 `continueLogUpload` / `fullLogUploaded` 属于用户反馈工单流程，由用户主动继续上传；
  按「用户主动上传」处理，**保留**。

### 3.6 渲染进程 / scheduler / host 审计

- 渲染进程 bundle 中未发现直连 `zcode.z.ai/api/v1/event/report`、阿里云 RUM/OTLP 的 URL；渲染侧遥测由主进程
  `autoInject` 注入的 ARMS 承担，随主进程 ARMS 一并禁用。
- `out/scheduler/index.js` 的网络仅为功能端点（`api.z.ai`、`bigmodel.cn`、`zcode.z.ai/api/v1/oauth/token` 等）。
- `out/host/index.js` 的网络为 OAuth、模型 provider、以及 Telegram/飞书/企业微信等用户工具端点。
  此外，仓库快照采集/上传链路（`/api/v1/snapshot/upload-credential` 与对象上传）也存在于 host 侧，
  已由**仓库快照隐私补丁**（`snapshot-patch.mjs`，本报告不重复其证据）独立禁用。
- `resources/glm/zcode.cjs` 的 `/api/v1/*` 仅为 `agent/configs`、`client/configs`、`zcode-plan`（配置与计费），
  模型轨迹遥测走 OTLP（见 3.3）。

## 4. 补丁操作清单

补丁由两个模块组成，`npm run telemetry:check/apply/verify/rollback`（`telemetry-all.mjs`）**一键覆盖两个上报面**
并分项输出状态、失败返回非零、保留已写入备份：

### 4.1 ASAR 面（`telemetry-patch.mjs`，6 条规格，原位等长替换，保持 ASAR 头部几何不变）

| # | 条目 | 规格 id | 原始 → 替换 | 语义 |
| --- | --- | --- | --- | --- |
| 1 | `out/main/index.js` | `main.armsRum.enable` | `mi.init({enable:!0,…` → `…enable:!1…` | 关闭 ARMS RUM 采集 |
| 2 | `out/main/index.js` | `main.rendererActionTrace.exporterDisabled` | `function Ww(e){let t=nD(e);if(t)return new rD(` → `if(0)…` | 主进程 OTLP 导出器不可创建 |
| 3 | `out/main/chunk-6XM33EZR.js` | `main.armsRum.endpoint` | RUM URL 字面量 → 等长空白 | ARMS 端点不可达 |
| 4 | `out/main/chunk-HW54O52P.js` | `main.telemetryEventReport.sendReportAttempt` | `async function ie(T,V){…}` → `{/*telemetry-privacy:disabled …*/return}` | 事件上报传输零网络 |
| 5 | `out/main/chunk-DBVOEQ2Z.js` | `main.agentTelemetry.otlpEndpoint` | OTLP 端点字面量 → 等长空白 | Agent/主进程无上报端点 |
| 6 | `out/main/chunk-DBVOEQ2Z.js` | `main.agentTelemetry.otlpHeaders` | `x-arms-license-key=…` 头 → 等长空白 | 移除打包上报密钥 |

ASAR 面另有**只读 fail-closed 检查**：`crashReporterAssessment` 要求唯一一处 `crashReporter.start` 使用
`uploadToServer:!1` 且 submitURL 为不可路由的 `zcode.invalid/local-crash-only`；若未来构建出现远程崩溃上传，
`check`/`verify` 会判为未通过（退出非零），但不做任何代码改动。

### 4.2 Agent 文件面（`agent-telemetry-patch.mjs`，1 条规格）

`resources/glm/zcode.cjs` 是 ASAR 之外的独立文件，单独做严格补丁：

| 条目 | 规格 id | 原始 → 替换 | 语义 |
| --- | --- | --- | --- |
| `resources/glm/zcode.cjs` | `agent.modelTelemetry.prepareEnv` | `async function H4n(e,t={}){…}` → `{/*telemetry-privacy:disabled …*/return e}` | 硬阻断 Agent 遥测共用入口 |

备份与收据：

```
<app.asar>.telemetry-privacy.{header,entry.*}.bak / .receipt.json
resources/glm/zcode.cjs.telemetry-privacy.bak / .receipt.json
```

Agent 文件面收据记录补丁前后整档 SHA256、大小与**变更区域 offset/length**；`rollback` **只重写该区域**，
并要求「用备份区域替换后整档哈希等于补丁前哈希」才允许恢复——因此区域外的任何改动（或尺寸变化）都会被拒绝，
区域内的半截写入则可安全恢复。两个上报面是不同文件、各自独立备份，互不影响；`rollback` 按 LIFO（先 CLI 后 ASAR）。

## 5. 覆盖范围与证据边界

### 5.1 已核实覆盖（补丁后零网络）

| 路径 | 触发 | 补丁前证据 | 补丁后证据 |
| --- | --- | --- | --- |
| 事件上报 → `zcode.z.ai/api/v1/event/report` | 启动/日活/远端用量事件 | 真实 `ie` 调用 mock fetch 1 次 | 真实已补丁 `ie` 调用 mock fetch 0 次 |
| ARMS RUM → `…/rum/web/v2?…` | 启动、采集器事件、自定义事件 | 真实 SDK `mi.init({enable:!0})` + 端点常量 | `enable:!1` + 端点置空（真实 SDK 开关验证） |
| OTLP 模型轨迹 → `…/apm/trace/opentelemetry` | host/Agent 启动 | 真实 `nD` 解析出阿里云 URL；真实 `H4n` 初始化遥测 | 置空端点后 `nD` 返回 undefined |
| **Agent 遥测硬阻断（抗 `.env` 绕过）** | Agent 启动 | 真实 `H4n` 在有效端点 + `ZCODE_MODEL_TELEMETRY_ENABLED=true/1/on` 下调用 `a_s` 初始化 | 真实已补丁 `H4n` 在相同条件下调用 0 次，原样返回环境 |
| 主进程渲染动作 trace | 主进程启动 | 真实 `Ww` 构造导出器 1 次 | 真实已补丁 `Ww` 构造 0 次 |
| 崩溃远程上报 | 崩溃 | 静态证据未发现远程 submitURL（仅本地） | 无远程路径可禁用；由只读 fail-closed 检查持续把关 |

### 5.2 明确保留（不属额外上报，或用户主动）

模型 API 请求、OAuth/登录、计费/套餐、插件市场与官方插件资源、自动更新、会话分享（用户主动）、
反馈日志上传（用户主动）、MCP 与 Telegram/飞书/企业微信等用户工具、本地崩溃归档与本地诊断日志。

### 5.3 残余限制（未覆盖 / 无法证实）

1. **`.env` 重新注入 OTLP 端点已不再能启用 Agent 遥测**：`H4n` 硬阻断后，即使 `.env` 提供有效端点且开关为
   `true`，Agent 也不初始化（已用真实提取函数 + mock 证明）。但本补丁不修改 `glm/zcode.cjs` 的其它遥测辅助函数
   （`a8t`/`b_s`/`a_s` 保持原样），只阻断共用入口；若未来版本新增不经过 `H4n` 的入口，需要重新审计。
2. **提示词/会话正文是否曾被上报未获证实**：事件上报通道观察到的 `event_text` 为 UI 事件名、OTLP 属性为模型
   元数据，静态证据均**未证实**正文上传。本补丁禁用的是已确认的额外上报路径；**是否存在其他未知外发通道不做保证**。
3. **Crashpad 二进制行为未动态验证**：只对应用代码字符串做只读审计；未反汇编/动态跟踪 `crashpad_handler` 自身，
   因此不能据静态结论断言任何情况下都无远程崩溃上传。
4. **渲染进程为静态 URL 审计**：未做运行时抓包；证据基于 bundle 中的端点字符串与主进程注入配置。
5. **未来版本可能新增上报路径**：工具以钉住签名拒绝未知版本；升级后需重新审计并更新签名。
6. **不撤回已上报数据**：补丁只阻止后续上报，无法删除已发送的数据。
7. **运行中进程**：补丁需要完全退出并重启 ZCode 才加载；脚本不终止进程。

## 6. 与快照补丁的关系

两个补丁修改不同的 ASAR 条目，但都会重写同一个 ASAR 头部区域（各自条目的 integrity）。已测试：

- 两种应用顺序均可成功 apply/verify；
- 回滚必须按 LIFO（后应用的先回滚），乱序回滚被拒绝且不破坏归档；
- 任一补丁的 `verify` 在**另一个补丁于其后应用**时会因归档哈希基线变化而报 `does not match the receipt`，
  这是预期交互：请在应用后立即 verify，或按 LIFO 回滚后再 verify。
