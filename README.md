# ZCode 推理参数兼容补丁

升级 ZCode 后，具备思考能力的模型在新建会话时可能直接报错：

```text
未知请求字段：reasoning.effort
provider_code=UNKNOWN_FIELD status=400
```

这个补丁用来处理 ZCode 3.12.3 中的一处通用请求参数兼容问题：具备思考能力的模型会经过同一套 Chat Completions 规则，结果同时发送两种格式的推理参数，而不少兼容接口不接受其中的 `reasoning.effort`。目前观察到的问题并不局限于某个模型或某一家服务商。

**不需要关闭模型的思考能力，也不需要改 API Key 或模型配置。** 补丁只移除通用规则中多加的字段，保留原有推理等级。`glm-5.3-flash` 只是最早排查时使用的复现案例，不是补丁的适用范围。

> 目前已通过离线测试，尚未完成真实接口验证。它不是针对所有 400 错误的通用修复，请先确认你的报错与 `reasoning.effort` 有关。

## 使用方法

需要 Windows 和 Node.js 18 或更高版本。项目没有第三方依赖，不用运行 `npm install`。

```powershell
git clone https://github.com/emengweb/zcode-reasoning-effort-fix.git
cd zcode-reasoning-effort-fix
```

先检查当前版本是否适用：

```powershell
npm run check
```

显示 `patchable` 表示找到了待修复的规则。接着应用补丁：

```powershell
npm run apply
```

如果提示没有写入权限，请用管理员 PowerShell 重新运行。脚本会先备份原文件，不会自动提权。

最后检查结果：

```powershell
npm run verify
```

显示 `no-nested-reasoning`，表示目标规则中已经没有嵌套的 `reasoning` 字段。这里检查的是本地文件，不会向模型发送请求。

**脚本不会关闭或重启 ZCode。** 已打开的 ZCode 可能缓存了旧规则，不一定立即生效。等手头的对话处理完，再自行选择时间重新打开 ZCode，用原来的模型和推理等级新建对话测试。

## 撤销补丁

在项目目录运行：

```powershell
npm run rollback
```

备份保存在原文件旁边：

```text
zcode-builtin.json.reasoning-fix.bak
zcode-builtin.json.reasoning-fix.receipt.json
```

第二个文件记录修改前后的校验值。如果打补丁后 ZCode 又升级了，或者目标文件被其他操作修改过，回滚会停止，而不是直接用旧文件覆盖新版本。回滚成功后，这两个文件会自动删除。

应用和回滚时，请不要同时升级 ZCode 或编辑它的安装文件。

## 补丁改了什么

目标是 ZCode 安装目录中的内置协议规则：

```text
C:\Program Files\ZCode\resources\config\provider\zcode-builtin.json
```

在检查到的 3.12.3 版本里，通用 `openai-chat-completions` 规则会把同一个推理等级转换成两份参数。以 `high` 为例，相关部分如下：

```json
{
  "reasoning_effort": "high",
  "reasoning": {
    "effort": "high"
  }
}
```

补丁移除第二份，只保留 Chat Completions 规则中原本使用的推理参数：

```json
{
  "reasoning_effort": "high"
}
```

规则里的 `thinking`、`enable_thinking` 和模型能力声明都保持原样。OpenAI Responses 使用的是另一条规则，其中的 `reasoning.effort` 不受影响。

这里修改的是应用随附的协议映射，不是 `.zcode` 下的用户配置，也不改 `zcode.cjs` 主程序。脚本只接受已经核对过的映射内容；遇到不认识的版本或结构会报错退出，不会尝试猜着改。

### 适用范围

这是一条通用 Chat Completions 规则，因此补丁会影响所有继承它的思考模型，不按模型名做特殊处理。当前反馈中，多种具备思考能力的模型在升级后都出现了同类错误，且主要集中在新会话。

有些兼容服务可能恰好需要嵌套的 `reasoning` 扩展；如果某个模型在打补丁后出现异常，请先回滚。

本次排查确认了当前版本里的重复映射，但没有取得失败请求的完整 HTTP 报文，也没有拿旧版代码做对比。所以目前能确认的是这个字段的生成位置和补丁后的请求构造结果，不能保证所有上游接口都接受剩下的参数。

如果 ZCode 的运行时规则覆盖了安装目录里的规则，修改本地文件也可能不生效。遇到这种情况，需要继续检查实际加载的规则，而不是反复应用补丁。

ZCode 升级也可能覆盖本补丁。升级后先运行 `npm run check`，不要直接套用旧备份。

## 测试

应用补丁**之前**运行：

```powershell
npm test
```

测试会读取本机安装的 ZCode 文件，在临时目录和内存中验证：

- 六种推理等级下，只有嵌套 `reasoning` 被移除，其他参数保持一致；
- 从当前 `zcode.cjs` 提取的请求包装函数能正确处理字符串请求体和 `Request` 对象；
- Responses 映射不变，重复应用不会重复修改文件；
- 备份可以完整还原，文件被其他操作改动后会拒绝回滚。

测试不联网、不启动 Agent，也不会改动安装文件。集成测试依赖本机**尚未打补丁**的 ZCode 3.12.3，并不是脱离安装环境就能运行的通用测试。

详细记录见 [TEST-RESULTS.md](TEST-RESULTS.md)。

## 其他命令入口

如果本机装了 `make`，可以使用对应命令：

| 操作 | npm | Make |
| --- | --- | --- |
| 检查是否适用 | `npm run check` | `make check` |
| 运行离线测试 | `npm test` | `make test` |
| 应用补丁 | `npm run apply` | `make apply` |
| 检查本地补丁状态 | `npm run verify` | `make verify` |
| 撤销补丁 | `npm run rollback` | `make rollback` |

PowerShell 入口也保留了：

```powershell
powershell -ExecutionPolicy Bypass -File .\apply-patch.ps1 -Confirm
powershell -ExecutionPolicy Bypass -File .\verify-patch.ps1
```

如果 ZCode 不在默认目录，可以直接传入目标文件路径：

```powershell
node .\patch.mjs check 'D:\ZCode\resources\config\provider\zcode-builtin.json'
node .\patch.mjs apply 'D:\ZCode\resources\config\provider\zcode-builtin.json' --confirm
node .\patch.mjs rollback 'D:\ZCode\resources\config\provider\zcode-builtin.json' --confirm
```

这只改变补丁操作的目标路径；集成测试仍然读取默认安装目录。
