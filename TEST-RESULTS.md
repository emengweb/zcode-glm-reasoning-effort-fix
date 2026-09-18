# 测试记录

本项目针对的是 ZCode 升级后，具备思考能力的模型在新会话中出现的通用 reasoning 参数问题；并非 GLM 专属修复。GLM-5.3-flash 是排查时使用的复现模型之一。

执行日期：2026-09-18

命令：

```text
node tests/test-mapping.mjs
node tests/integration.mjs
```

结果：通过。

- chat mapping removes only nested reasoning.effort; Responses mapping remains intact; idempotent.
- level: low/high/max/disabled/enabled/none 全部通过。
- 安装版 `zcode.cjs` 的真实请求包装函数：字符串 body 和 Request 两条路径均通过 mock transport；未发送真实网络请求。
- 备份、幂等、回滚完整性、并发变更拒绝、签名/schema 拒绝全部通过。
- 安装规则文件测试前后 SHA-256：`2e6076515546b4120e5bb9d1ff3ec347fadf32c83d8378d7d6f72a0af07d6caf`，未被修改。
- 安装运行时 `zcode.cjs` SHA-256：`da61b0663336a65f7cce3dec223678794ccaa58158e304fc0d97b695434a8f01`，未被修改。

边界：以上是离线请求构造验证，不是真实 provider 请求；补丁在本次交付过程中没有应用。实际应用后需要用户在方便时重新加载 ZCode 并新建对话验证。脚本不会操作任何 ZCode 进程。

---

# 快照隐私补丁测试记录（2026-09-18）

对象：仓库快照采集上传禁用补丁（`snapshot-patch.mjs`），目标 ZCode 3.12.3 / Electron 41.0.3 的
`C:/Program Files/ZCode/resources/app.asar` 中 `out/host/index.js` 的五个方法入口。
本次交付**没有**修改真实安装，所有写入都发生在临时目录。

## 命令与结果

```text
node --check snapshot-patch.mjs / test-snapshot.mjs / tests/*.mjs
  结果：全部通过。

npm run test:snapshot
  结果：3 组全部通过。
  - 逻辑：原位等长替换、幂等、未知/歧义签名拒绝、ASAR 头部几何（数据区起点 = 8 + uint32LE(4)，
    JSON 长度非 4 倍数时按对齐计算）、多块/空文件完整性、融合开关解析、合成 PE 内嵌完整性资源解析，
    以及「融合开关启用且哈希匹配时 apply 拒绝写入」。
  - 端到端（合成 ASAR，临时目录）：apply → verify → 重复 apply 幂等 → rollback；其他条目逐字节不变；
    条目完整性只更新主机条目；未知主机签名拒绝；已有备份拒绝覆盖；外部改动导致 verify 失败且 rollback 拒绝；
    备份损坏、收据与目标不匹配时拒绝回滚；CLI check/apply/verify 行为正确。
  - 副作用计数（VM + mock，真实安装只读）：原始方法全部触发 mock，已补丁方法计数全为 0。

node tests/test-snapshot-real-copy.mjs
  结果：全部通过，耗时约 18 秒。
  - 真实 app.asar 副本初始状态 patchable，主机哈希与签名一致；
  - apply 成功（5 个入口）；深度验证通过，逐条目完整性校验 26773 个通过，跳过 12 个 unpacked 条目；
  - 重复 apply 幂等；rollback 后整个 ASAR 与原件逐字节一致（SHA-256 还原为 47555330…）。

node snapshot-patch.mjs verify   （真实安装，只读）
  结果：预期「未通过：host bundle is not patched」。
  - 已校验条目 26773 个（跳过 12 个）；归档 SHA256 47555330451964630b14950ce7dd496a33102ecf281d251900fe7c73252fbc7e。

node snapshot-patch.mjs check    （真实安装，只读）
  结果：状态 PATCHABLE；条目完整性自洽；
  - 融合开关版本 1，共 9 项，状态串 101100011；
  - EnableEmbeddedAsarIntegrityValidation = 0（关闭）；
  - 可执行文件内嵌 app.asar 完整性记录存在（value af904d14…，与当前头部不匹配，当前惰性）；
  - 阻断风险评估：none。
```

## 最终复验

`npm test` 四组全部通过，`npm run test:snapshot:real` 全部通过，`git diff --check` 通过。推理集成测试现在支持已打补丁的安装：本机采用通过收据与前后哈希验证的原始备份，不跳过真实请求包装函数测试；备份不可用时使用固定映射夹具。

补充用例覆盖位置参数目标解析、PE 解析失败时拒绝默认放行、缺收据验证失败、修改前记录最终哈希、部分写入回滚、区域外改动拒绝恢复。真实安装缺失时测试会明确标记跳过，不作为完整覆盖报告。

## 关键证据

- 主机条目原始 SHA-256：`c8f7b2e50f2c8f7eeb030a377cfc4779b2a0e2037af2239e065157dc2e3e422e`（与归档内 integrity 一致）
- 主机条目打补丁后 SHA-256：`5b356cbaf445315bd6421457caafe98e116ebe626513616a1d0b47bc30e5d033`
- 归档头部前四个 uint32LE：`4, 7013000, 7012996, 7012990`；数据区起点 `7013008`
- 测试过程中真实安装文件未被写入：本次只执行了 `check`、`verify`（只读）与真实副本的复制版操作。

## 边界

- 以上是离线验证与真实归档副本验证，**未在真实安装上应用补丁**，也未启动或重启 ZCode。
- 真实副本测试验证的是补丁写入与完整性更新逻辑；补丁是否在你的机器上生效，需要应用后完全退出并重启 ZCode，
  再按自己的判断验证。历史已上传内容无法撤回，其他数据外发通道不在本补丁范围内。

---

# 遥测上报禁用补丁测试记录（2026-09-18）

对象：遥测/额外上报禁用补丁（`telemetry-patch.mjs`），目标 ZCode 3.12.3 / Electron 41.0.3 的
`C:/Program Files/ZCode/resources/app.asar` 中 4 个主进程条目的 6 处锚点。
本次交付**没有**修改真实安装，所有写入都发生在临时目录；未启动或重启 ZCode。

## 命令与结果

```text
npm test
  结果：全部通过（原有推理、快照套件 + 新增 4 组遥测套件）。

npm run test:telemetry
  结果：4 组全部通过。
  - 逻辑与真实字节比对（真实安装只读）：6 条规格等长且幂等；真实文件中每个锚点各出现一次；
    4 个条目原始/已补丁 SHA256 与钉住签名一致；改动仅落在预期字节范围；
    模型/功能标记（resolveZCodeEndpointOrigin、zcode-plan、spawnHostProcess、nD/Mw、
    createTelemetryCore、事件负载构造、zcode-cli-agent 服务名）在补丁后仍逐字节存在；
    RUM/OTLP 地址与 x-arms-license-key 已置空。
  - 合成 ASAR 端到端：apply（6 条）→ verify（6 条目逐条完整性）→ 重复 apply 幂等 → rollback 逐字节还原；
    错误版本几何、未知条目字节、部分打补丁状态、已有备份、外部改动、备份损坏、收据目标不匹配、
    其他工具收据、缺收据基线等拒绝路径全部通过；CLI 位置参数与 --confirm 行为正确。
  - 真实提取函数 + mock：原始事件上报传输调用 mock fetch 1 次，已补丁传输 0 次；
    原始 Ww 构造 OTLP 导出器 1 次，已补丁 0 次；真实 nD 对原始打包环境解析出阿里云 URL，
    对已补丁环境返回 undefined；真实 Agent 开关 a8t/b_s/H4n 在端点置空或
    ZCODE_MODEL_TELEMETRY_ENABLED=false 时不初始化模型遥测；真实 ARMS 采集开关在 enable:false 时关闭。
  - 组合兼容：遥测补丁与快照补丁两种应用顺序均 apply/verify 成功，按 LIFO 回滚后逐字节还原，
    乱序回滚被拒绝且不破坏归档。

npm run test:telemetry:real
  结果：全部通过（复制真实 app.asar 到临时目录，约 300 MB）。
  - 初始 patchable，4 个目标条目与签名一致；
  - apply 成功（6 条）；深度验证通过，逐条目完整性校验 26773 个通过、跳过 12 个 unpacked；
  - 重复 apply 幂等；rollback 后整个 ASAR 逐字节还原；
  - 真实安装已带快照补丁，遥测补丁循环后快照补丁仍验证通过（互不破坏）。

node telemetry-patch.mjs check   （真实安装，只读）
  结果：状态 PATCHABLE；4 个条目完整性自洽；
  - 融合开关版本 1，共 9 项，状态串 101100011；EnableEmbeddedAsarIntegrityValidation = 0（关闭）；
  - 阻断风险评估：none。
```

## 关键证据

- 目标条目原始 SHA-256（前 16 位）：
  `out/main/index.js` `5105c8659924d8c2…`、`chunk-6XM33EZR.js` `71142091b7d289cb…`、
  `chunk-HW54O52P.js` `cc3c2b267bf86d7f…`、`chunk-DBVOEQ2Z.js` `4ecc6034b1aaf431…`
- 目标条目已补丁 SHA-256（前 16 位）：
  `496f01cad77b688a…`、`f3526ea30a4f2ef2…`、`25904d7a3e6231c2…`、`5c306da56513e9be…`
- 归档头部前四个 uint32LE：`4, 7013000, 7012996, 7012990`；数据区起点 `7013008`
- 测试过程中真实安装文件未被写入：只执行了 `check`（只读）与真实副本的复制版操作。

## 边界

- 以上是离线验证与真实归档副本验证，**未在真实安装上应用补丁**，也未启动或重启 ZCode。
- 「零网络」是在 mock transport 层面证明的：真实提取的原始函数会调用注入的 fetch mock，已补丁函数不会；
  不是运行时抓包。
- 未发现自动的崩溃远程上报与诊断日志上传，因此没有对应阻断点；Crashpad 二进制行为未动态验证。
- 本地 `.env` 中的 `OTEL_EXPORTER_OTLP_*` 可能重新启用 Agent 侧模型遥测；建议同时设置
  `ZCODE_MODEL_TELEMETRY_ENABLED=false`（真实开关，已由测试验证）。
- 历史已上传内容无法撤回；升级 ZCode 后需重新检查适用性。

---

# Agent 遥测硬阻断 + 组合驱动测试记录（2026-09-18）

对象：`agent-telemetry-patch.mjs`（`resources/glm/zcode.cjs` 的 `H4n` 共用入口硬阻断）与
`telemetry-all.mjs`（一键覆盖 ASAR + CLI 两个上报面）。本次交付**没有**修改真实安装。

## 命令与结果

```text
npm test
  结果：全部通过（推理/快照/遥测 ASAR/遥测 Agent 共 11 组）。

npm run test:telemetry
  结果：7 组全部通过（遥测 4 组 + Agent 逻辑/端到端/硬阻断行为 3 组）。
  - Agent 逻辑：单条规格等长、幂等；真实包 SHA256/大小与签名一致；改动只落在 H4n 范围；
    a8t/b_s/a_s/运行时与注解标记逐字节保留；原条件判断不再存在。
  - Agent 端到端：合成文件 apply/verify/幂等/rollback 逐字节还原；未知 SHA、已有备份、外部改动、
    备份损坏、收据目标不匹配、其他工具收据、损坏收据、缺失文件均被拒绝；区域内半截写入可恢复，
    区域外改动被拒绝；CLI 行为正确。
  - Agent 硬阻断行为：原始 H4n 在有效端点 + 开关 true 下调用 a_s 初始化 1 次；已补丁 H4n 在
    端点有效且开关 true/1/on/未设置下均调用 0 次并原样返回环境；已补丁包不再含 a_s 调用点。

npm run test:telemetry:combined:real
  结果：全部通过（复制真实 app.asar + glm/zcode.cjs）。
  - 一键 check/apply/verify/rollback 覆盖两个上报面；ASAR 6 条、CLI 1 条；
  - 两个副本回滚后逐字节还原；
  - 一个上报面失败时整体非零、分项状态区分成功/失败、已写入备份保留；
  - 仅一个面上报补丁时 checkAll 给出部分安装警告。
```

## 关键证据

- Agent 包原始 SHA-256：`da61b0663336a65f7cce3dec223678794ccaa58158e304fc0d97b695434a8f01`
- Agent 包已补丁 SHA-256：`6cc4e410a933506888bb261558d48642d945d1932e883556a3324431c91361a1`
- `H4n` 原始长度 249 字节，替换后仍为 249 字节（原位等长）。

## 边界

- 「零初始化」是在 mock 层证明的：真实提取的原始 `H4n` 会调用注入的 `a_s`，已补丁 `H4n` 不会；
  不是运行时抓包。
- 提示词/会话正文是否曾被上报未获证实；本补丁禁用已确认的额外上报路径，未知通道不做保证。
- 崩溃远程上报为静态证据未发现 + 只读 fail-closed 检查；Crashpad 二进制未动态验证。
