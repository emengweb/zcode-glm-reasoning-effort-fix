# 测试记录

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
