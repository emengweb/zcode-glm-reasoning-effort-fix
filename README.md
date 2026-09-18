# ZCode `reasoning.effort` 兼容性修复补丁

## 问题

ZCode 升级后，`openai-compatible` / `openai-chat-completions` 请求的通用模型选项映射同时生成了以下两个字段：

```json
{
  "reasoning_effort": "high",
  "reasoning": {
    "effort": "high"
  }
}
```

其中 `reasoning.effort` 是 OpenAI Responses 风格的字段。部分 OpenAI-compatible 服务（包括当前使用的 `glm-5.3-flash` 上游接口）不接受该字段，因此返回：

```text
UNKNOWN_FIELD: reasoning.effort
```

`glm-5.3-flash` 本身支持推理，本补丁不会关闭推理，也不会修改 ZCode 用户配置。

## 修复思路

仅修改 ZCode 内置 provider 规则文件中的通用 `openai-chat-completions` 映射：

- 保留 `reasoning_effort`，供 Chat Completions 兼容接口使用；
- 保留 `thinking` 和 `enable_thinking`，因为部分兼容服务需要这些字段；
- 删除重复且不属于 Chat Completions 通用协议的嵌套 `reasoning.effort`；
- 不修改 `openai-responses` 的 `reasoning.effort` 映射；
- 不修改模型配置、provider 配置或 ZCode 进程。

## 文件

- `apply-patch.ps1`：应用补丁，自动创建带时间戳备份；默认需要管理员权限，因为目标文件位于 `Program Files`。
- `verify-patch.ps1`：只读验证安装文件是否已经是修复后的规则；不联网、不启动/关闭 ZCode。
- `tests/test-mapping.mjs`：离线测试映射结果。
- `patch.diff`：说明性 unified diff。

## 当前验证结果

在临时内存对象上验证了修复后的映射：

- `high` 会生成 `reasoning_effort: high`；
- 不再生成 `reasoning`；
- `disabled` 会生成 `reasoning_effort: none`；
- `max` 会生成 `reasoning_effort: max`；
- Responses API 映射仍单独生成 `reasoning.effort`；
- 原始安装文件未被本项目修改。

## 应用方式

> 应用补丁前不需要关闭或重启现有 ZCode 进程。补丁只修改下次启动时读取的规则文件。若 ZCode 已经缓存了规则，需由用户之后自行决定何时重启 ZCode；本补丁脚本不会自动重启。

在 PowerShell 中运行：

```powershell
cd C:\Users\lenovo\project\zcode-glm-reasoning-effort-fix
powershell -ExecutionPolicy Bypass -File .\apply-patch.ps1
```

然后验证：

```powershell
powershell -ExecutionPolicy Bypass -File .\verify-patch.ps1
```

应用脚本会：

1. 检查目标文件；
2. 校验 JSON；
3. 确认目标规则是 `openai-chat-completions`；
4. 确认原规则确实包含待删除的 `reasoning` 映射；
5. 创建备份；
6. 只删除该映射；
7. 再次校验 JSON 和补丁结果。

回滚：

```powershell
Copy-Item .\backups\zcode-builtin.json.<timestamp>.bak `
  'C:\Program Files\ZCode\resources\config\provider\zcode-builtin.json' -Force
```

## 注意事项

- ZCode 升级后可能覆盖 `zcode-builtin.json`，届时需要重新运行补丁。
- 补丁脚本不会自动重启、关闭或终止 ZCode。
- 本补丁没有向真实服务发送请求；实际线上验证需要用户在方便时自行新建对话测试。
- 如果上游实际要求的字段不是 `reasoning_effort`，应保留离线测试结果并根据上游协议调整映射，不应直接删除全部 reasoning 参数。

## Git

本目录是独立 Git 仓库，提交记录用于保存补丁和分析说明，不包含 ZCode 安装文件或用户密钥。
