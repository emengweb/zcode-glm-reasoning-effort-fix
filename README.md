# ZCode reasoning.effort 补丁包

## 原因与证据

ZCode 3.12.3 内置的通用 `openai-chat-completions` 规则在处理 reasoningLevel 时，同时生成顶层 `reasoning_effort` 和嵌套 `reasoning.effort`。当前上游返回 UNKNOWN_FIELD: reasoning.effort，与该多余字段一致。GLM-5.3-flash 支持推理，本补丁不关闭推理。

已经从当前安装文件确认上述重复映射，并离线执行安装版真实请求包装函数验证。没有捕获本次失败请求的完整 HTTP 数据，也没有对比旧版本文件，因此不能声称已经证明升级前的精确行为或所有服务端兼容性。

## 解决思路和范围

仅对应用内置规则文件中的通用 Chat Completions 映射作精确字符串补丁，删除嵌套 reasoning 对象，保留 reasoning_effort、thinking、enable_thinking 和全部模型能力。Responses 规则不变。

目标文件：
`C:\Program Files\ZCode\resources\config\provider\zcode-builtin.json`

这是应用内置协议规则补丁，不是修改 zcode.cjs，也不是修改 `.zcode` 用户配置。通用规则补丁会影响所有继承该规则的模型，不仅 GLM。某些兼容服务可能依赖嵌套 reasoning 扩展，请先检查并保留回滚能力。若运行时远程规则覆盖本地规则，本补丁可能不生效；不能据此继续修改用户缓存，应进一步检查实际规则来源。

## 环境

Windows PowerShell、Node.js 18+。不需要 npm install，不下载依赖。修改 Program Files 时可能需要管理员 PowerShell。脚本不提权，不联网，也没有任何进程关闭或重启操作。

## 使用

```powershell
cd C:\Users\lenovo\project\zcode-glm-reasoning-effort-fix
# 只读预览
node .\patch.mjs check
# 离线测试，integration 需要当前安装仍是未打补丁版本
node .\tests\test-mapping.mjs
node .\tests\integration.mjs
# 应用：只有这一步修改安装文件
powershell -ExecutionPolicy Bypass -File .\apply-patch.ps1 -Confirm
# 只读检查；期望 status 为 no-nested-reasoning
powershell -ExecutionPolicy Bypass -File .\verify-patch.ps1
```

也可以直接应用：
```powershell
node .\patch.mjs apply 'C:\Program Files\ZCode\resources\config\provider\zcode-builtin.json' --confirm
```

脚本要求唯一规则和精确映射签名，不匹配则拒绝修改。再次应用为幂等操作。备份在目标文件旁边：
- `zcode-builtin.json.reasoning-fix.bak`
- `zcode-builtin.json.reasoning-fix.receipt.json`（修改前后 SHA256）

## 回滚

```powershell
node .\patch.mjs rollback 'C:\Program Files\ZCode\resources\config\provider\zcode-builtin.json' --confirm
```

回滚校验备份和当前文件哈希。如果安装文件后来被升级器或其他操作修改，将拒绝覆盖，以免损失其他改动。成功恢复后删除此次备份和收据。写入不是跨进程事务，请勿同时升级或修改安装文件；已有 ZCode 进程不需要由脚本关闭。

## 生效与验证边界

现有进程可能已缓存规则，不能保证即时生效。脚本不会重启 ZCode，用户自行选择方便的时机让程序重新加载，再新建对话测试同一 provider、模型和思考等级。若仍出错，保留错误详情，不应关闭推理规避。

离线测试不等于真实接口已经恢复。当前交付时未应用补丁，安装文件和用户配置均未修改。升级可能覆盖补丁，升级后必须先 check，不应盲目重打。

## 已完成测试

- low/high/max/disabled/enabled/none 六种等级：只删除嵌套 reasoning，其他输出逐项一致。
- 从安装版 zcode.cjs 提取实际 Iqr 包装函数，以 mock fetch 验证字符串 body 和 Request 两条路径；无真实网络请求。
- Responses 映射不变；重复应用幂等。
- 临时文件应用、备份和字节级回滚通过。
- 非预期 schema/映射和修改后漂移会拒绝处理。
- 测试前后安装规则 SHA256 相同。

详见 TEST-RESULTS.md。项目为独立 Git 仓库，不包含用户配置、密钥或完整安装 bundle。
