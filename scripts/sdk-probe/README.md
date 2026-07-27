# SDK 行为探针

验证 **SDK 收到我们的配置后到底怎么表现** —— 单元测试只能验"我传了什么"。

这个区别不是学术上的。这一轮修的六个缺陷,全都是"配置传下去了、界面显示着、
运行时不生效"的形状。用只断言配置形状的测试去守护它们,等于用同一个盲区
守护同一类问题。

## 怎么跑

```bash
node scripts/sdk-probe/deny-blocks-tool.mjs   # 围栏拒绝时,命令是否真的没执行
node scripts/sdk-probe/guard-matrix.mjs       # 四种权限配置 × 新旧两种围栏的对照
```

不花钱、不联网、不需要 API key。单次十几秒到两分钟。

## 原理

只把**模型**换成假的,其余全真:

```
真实 Claude Code 子进程
  ↓ 请求模型
假网关(fake-gateway.mjs) → 按剧本返回 tool_use(Bash, "echo hit > /tmp/xxx")
  ↓
真实 PreToolUse hook 通道(control_request)
  ↓ deny
真实工具执行路径
  ↓
判据:那个文件到底在不在磁盘上
```

判据刻意选了"文件存不存在"而不是"返回了什么" —— 后者可以被任何一层伪造,
前者不能。

## 为什么不用真模型

试过,栽了两次:

1. **模型不配合。** 演示拒绝路径时用 `rm -rf`,模型自己就拒绝执行,Bash 压根
   没被调用。测试"通过"了,但什么都没验证到 —— 差点把"模型不配合"当成"围栏生效"。
2. **凭证会失效。** DashScope 的 key 过期后,验证直接做不了,而缺陷还在线上跑着。

## 踩过的坑:本机登录态会抢占

只设 `ANTHROPIC_BASE_URL` 是不够的。本机 Claude Code 处于登录状态时,SDK 会拿
OAuth 凭证去打官方端点,表现为 `401 authentication_failed` 无限重试,而假网关
**一条 TCP 连接都收不到** —— 看日志像是"网关没起来",实际是请求根本没往这儿发。

必须同时:

```js
ANTHROPIC_AUTH_TOKEN: "",     // 防 OAuth 抢占
CLAUDE_CONFIG_DIR: 临时空目录,  // 隔离 ~/.claude.json 里的登录态
```

生产代码 `aliasEnv` 里那行 `ANTHROPIC_AUTH_TOKEN: ""` 就是同一个理由。

## 已验证的结论

`guard-matrix.mjs` 的输出(2026-07-27):

```
配置                      | 旧 canUseTool  | 新 PreToolUse hook
--------------------------|----------------|-------------------
default,不配白名单          | ✓ 拦住          | ✓ 拦住
default + 裸白名单 Bash     | ✗ 命令执行了     | ✓ 拦住
bypassPermissions         | ✗ 命令执行了     | ✓ 拦住
bypassPermissions + 白名单  | ✗ 命令执行了     | ✓ 拦住
```

「命令执行了」= 文件真的出现在磁盘上,不是推断。

这同时证明了两件事:改之前那三种配置下围栏形同虚设;改之后连
`bypassPermissions` 都绕不过去 —— 后者是权限模式敢开放给用户配置的全部前提。

## 没有进 CI

单次要拉起真实 SDK 子进程,比整个单测套件还慢。目前定位是**改动权限/围栏
相关代码后手动跑一遍**。如果将来这类回归重复发生,再考虑放进夜间流水线。
