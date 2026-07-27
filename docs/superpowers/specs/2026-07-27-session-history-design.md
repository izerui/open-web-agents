# 会话历史重建

打开一个旧会话时,把当时的对话原样显示出来。

## 现状:不是加载失败,是从未存过

`workbench.tsx:57` 的 `openSession()` 只有一行 `setTurns([])`。这不是 bug,是下游症状 ——
上游根本没有历史可加载:

| 数据 | 现状 |
|---|---|
| 每轮用户 prompt | ✅ `runs.prompt` |
| 轮次顺序、分支关系 | ✅ `runs.parentRunId` + `createdAt` |
| 结构化结果、成本 | ✅ `runs.structuredResult` / `runs.cost` |
| **agent 回复正文** | ❌ 不落库 |
| **工具调用与结果** | ❌ 不落库 |
| status / usage / question 事件 | ❌ 仅在进程内存,重启即失 |

事件流只活在 Redis pub/sub(发完即弃)和 `ReplayBuffer`(`replay-buffer.ts:25`,进程内存 Map)。
后者的 noise 类(`text` / `thinking` / `tool_use` / `tool_result`)只保最近 200 条,
且新一轮开始会 `reset()` 清桶。它的设计目标是断线重连,不是查看历史。

### 两个会误导后来人的痕迹

调查时差点被它们带偏,记下来:

1. **`messages` 表是死表。** schema(`schema.ts:76-86`)和迁移(`drizzle/0000_*.sql:52`)都建了,
   全仓零处读写。它看起来像"对话历史已经设计好了"。
2. **`STATE_EVENT_KINDS` 不是持久化开关。** 名字像在筛"哪些事件要存",实际只用于
   `ReplayBuffer` 的内存淘汰分级(state 全留、noise 滚动丢弃)。两类都不落库。

## 决策:不落库,读 SDK 的 transcript

claude-agent-sdk 已经把每次运行完整写进了 jsonl transcript。这些文件就在
`sharedHome/.claude/projects/` 下 —— 而 `sharedHome = dataDir/.agent-home`
(`default-engine.ts:28`),在 compose 里位于 `owa_data` 卷内,**web 与 worker 挂的是同一个卷**。
所以这不是"只在开发机上碰巧能用"。

更关键的是 SDK 提供了官方读取 API,不需要自己解析 jsonl:

```ts
getSessionMessages(sessionId, { dir }): Promise<SessionMessage[]>
getSessionInfo(sessionId, { dir }): Promise<SDKSessionInfo | undefined>
```

`getSessionMessages` 的文档原话:"Parses the transcript, builds the conversation chain
via parentUuid links, and returns user/assistant messages in chronological order."

手写解析器需要做而 SDK 已经做掉的:逐行解析、按 `parentUuid` 重建对话链(分支时它是树
不是线性,这一条手写极易写漏)、时序排序、过滤 `attachment` / `queue-operation` /
`last-prompt` 行、目录名转义。

实测对照:同一会话,手写解析与 `getSessionMessages()` 输出一致。

### 代价(明确接受)

- **SDK 私有格式**。缓解:转换层隔离 + 契约测试(见测试章节)。
- **依赖共享卷**。当前 compose 拓扑成立;将来 worker 扩到多台机器且卷不共享时失效。
  官方解法是 `SessionStore` 适配器(见下),**本次不做**(YAGNI)。

### 长会话会看到残缺的历史 —— 这条无法回避

`session-storage.md:240` 原文:

> `getSessionMessages` 返回代理在恢复时会看到的链接消息链。自动压缩后,早期的轮次被
> 摘要替换,因此存储中包含 **503 个原始条目**的会话可能从 `getSessionMessages`
> 返回 **18 条消息**。对于完整的原始历史记录……直接调用 `store.load(key)`。

也就是说,一旦会话长到触发自动压缩,打开历史看到的**不是完整对话**。
而 `store.load()` 需要配 `SessionStore`,本地文件系统模式下没有这个入口。

**这比"读不到历史"更糟**:用户看到的不是错误提示,而是一段**看起来完整的短历史** ——
没有任何迹象表明前面还有内容。

对策不是假装完整,而是**把压缩这件事显式说出来**:

- SDK 在压缩时会发 `system` / `compact_boundary` 消息(`agent-loop.md:55-67`),
  当前被 `normalize.ts` 静默丢弃。改为转成一条 `status` 事件并落到 `runs`。
- 历史里在对应位置渲染"此处上下文已被压缩,早期内容仅存摘要"。

要拿到未压缩的原始历史,唯一的路是上 `SessionStore`(Redis/Postgres 参考实现现成,
本项目两者都有)。那是独立议题,不在本次范围。

### transcript 保留期(已解决)

原设计漏了一条:`cleanupPeriodDays` 默认 **30 天**,到期 SDK 自己删掉 jsonl。
除了历史消失,`resume` 找不到文件时会**静默开新会话而不报错**,表现成"助手突然失忆"。

已在 `options.ts` 显式设为一年。不设永久是因为磁盘无上限增长会把队列和数据库一起拖垮。

## 三个实测得出的硬约束

### 1. 必须设 `CLAUDE_CONFIG_DIR`

SDK 从 `~/.claude/projects` 找 transcript。Node 主进程的 HOME 是宿主用户目录,
而 agent 子进程的 HOME 被 `options.ts:98` 改成了 `sharedHome`。实测:

```
默认 HOME            → getSessionMessages 返回 0 条
CLAUDE_CONFIG_DIR    → 返回 6 条,getSessionInfo 有完整元数据
  = sharedHome/.claude
```

选 `CLAUDE_CONFIG_DIR` 而非改 `process.env.HOME`:前者是 SDK 内部明确读取的变量
(`sdk.mjs` 中可见),只影响 Claude 自身;改 HOME 会波及进程内所有依赖 HOME 的库。

设置点:容器装配处(`container.ts`),与 `sharedHome` 的推导保持同源,避免两处各算一次。

### 2. 入口只能是 `runs.sdkSessionId`,绝不扫目录

一个会话目录下可能有多个 jsonl。实测查明三个原因,其中两个是陷阱:

| 原因 | 实例 | 是否该显示 |
|---|---|---|
| 不 resume 的新一轮开新 SDK session | `c38d9883` 两轮两文件,DB 两个 sdkSessionId 都在 | ✅ 该显示 |
| **run 重试,每次 attempt 一个文件** | `b113539f`:1 个 run、`attempts=2`、两个文件,首条 user 完全相同 | ❌ 失败那次不该显示 |
| **run 失败留下孤儿文件** | `82391ad5` 的 failed run,DB 里 `sdk_session_id` 为 null | ❌ 不该显示 |

扫目录会把重试的两遍都渲染出来,看起来像 agent 干了两次。
以 DB 登记的 `sdkSessionId` 为唯一入口,孤儿与失败尝试自动被排除。

反向验证:6 轮的会话 `5614b410`,六个 run 共用同一个 `sdkSessionId` —— resume 追加到同一文件。

### 3. 用户说的话以 `runs.prompt` 为准

SDK 过滤掉了 attachment 等结构性噪声,但**系统注入的 user 消息不过滤**。
实测在会话 `0ad503a0` 中,`<task-notification>...` 以普通 user text 出现。

对策不是写正则匹配这些标签(那是打地鼠,SDK 将来新增一种注入就漏一种),而是:

> jsonl 里的 user 消息**只取 `tool_result` 块**,其余一律不渲染成用户输入。
> 用户说了什么,权威源是 `runs.prompt`。

数据库负责"人说了什么",transcript 负责"agent 做了什么"。职责不重叠,也就不会打架。

## 设计

```
GET /api/sessions/[id]/history
  ├─ 鉴权:会话归属校验(复用现有 grants 那套)
  ├─ runs.listBySession(id) → 有序 (runId, prompt, status, sdkSessionId)
  ├─ 逐个有 sdkSessionId 的 run:
  │    getSessionMessages(sdkSessionId, { dir: workspaceDir })
  │      └─ SessionMessage[] → AgentEvent[]   (纯函数,无 IO)
  └─ { turns: [{ runId, prompt, status, events }] }
```

返回结构就是前端现有的 `Turn`,`openSession()` 直接 `setTurns`。
**`Conversation` 组件一行不改** —— 吐出来的正是它已经在渲染的 `AgentEvent`。

### 单元划分

| 单元 | 职责 | 依赖 |
|---|---|---|
| `TranscriptPort` | 接口:`read(sdkSessionId, dir)` + `info(sdkSessionId, dir)` | 无 |
| `claude-sdk/transcript.ts` | 调 SDK,唯一碰 SDK 历史 API 的地方 | SDK |
| `domain/from-transcript.ts` | `SessionMessage[] → AgentEvent[]`,纯函数 | 无 |
| `application/history.ts` | 拼 runs 与 transcript,组装 `Turn[]` | 两个 port |
| `api/sessions/[id]/history` | 鉴权 + 序列化 | application |

转换函数保持纯粹是刻意的:它是最容易随 SDK 变化而出错的一环,也是最需要密集测试的一环。
不碰文件系统才能用 fixture 密集地测。

### 架构规则要同步放宽

`architecture.test.ts:114` 现在断言 import SDK 的文件**恰好是** `default-engine.ts`。
新增 `transcript.ts` 会让它变红。

放宽为:import SDK 的文件都必须位于 `adapters/claude-sdk/` 目录下。
边界仍然机械可检,只是粒度从文件变成目录。

**README 里那句"全工程只有一个文件 import SDK"必须同步改掉。**
这个项目已经因为"文档声称与代码不符"栽过几次;规则改了而文档没改,
下一个读者的判断依据就是错的。

### 顺带:会话标题

`getSessionInfo()` 返回 `summary` 与 `firstPrompt`。
`sessions.title` 只在创建时由 body 传入,没有任何自动生成逻辑,所以多数会话是 null,
侧边栏显示的是 id 前 12 位。

会话列表接口在 `title` 为空时回退到 `summary`。

代价明确:列表页会因此产生 N 次磁盘读(每会话一次)。当前列表上限 100 条,
且 `getSessionInfo` 只读元数据不解析全文。若实测超过 200ms,改为并发读取。

## 错误降级

历史读取失败**不能**让整个会话打不开 —— 用户至少还应该看到自己问过什么。

| 情况 | 表现 |
|---|---|
| run 无 `sdkSessionId`(失败/取消) | 显示 prompt + 状态,无 agent 内容 |
| transcript 文件不存在(卷丢失、超期清理) | 该轮显示 prompt,附一行"历史记录不可用" |
| **会话被自动压缩** | 在压缩点渲染"早期内容仅存摘要",**不假装完整** |
| SDK 抛异常 | 同上,并记录日志;不向上冒泡 |
| 整个会话都读不到 | 仍显示所有轮次的 prompt 列表 |

即"永远不因为历史缺失而白屏"。

这些提示不需要新的 UI 类型:降级信息以现有的 `status` 事件表达
(`EventBlock` 已有 `● {label}` 的渲染分支)。前端"一行不改"的前提因此成立。

## 测试

**契约测试(最重要)**:把真实 jsonl 存成 fixture,断言 `getSessionMessages` 的输出形状
仍是我们依赖的那几个字段(`type` / `message.content` 的块类型 / `message.usage`)。
SDK 改格式时这个测试先红,而不是线上白屏。

**转换纯函数**:
- text / thinking / tool_use / tool_result 各自映射正确
- `is_error: true` → `isError`
- user 消息中的 `tool_result` 被采纳
- user 消息中的普通 text(含 `<task-notification>`)**不**产生用户输入事件
- usage 被正确提取

**应用层**:
- 多 run 按 createdAt 排序
- 无 `sdkSessionId` 的 run 仍产出一个只有 prompt 的 turn
- transcript 读取抛异常时降级而非失败

**e2e**:
- 未登录取历史 → 401
- 取他人会话历史 → 403
- 跑一轮 → 重新打开 → 历史里能看到那一轮的工具调用

**变异测试**:按既有惯例,逐条改坏实现,确认对应测试确实会红。
尤其是"扫目录 vs 按 sdkSessionId"这一条 —— 它是本设计里最容易被后人"顺手优化"掉的约束。

## 不做

- **不物化到数据库**。共享卷失效时再说,接口已经预留了替换点。
- **不改 branch 实现**。SDK 有 `forkSession()`,现有实现是自己的 `resumeAnchor`。
  两者能否合并是独立议题,与本次无关。
- **不展开 subagent 详细轨迹**。SDK 有 `getSubagentMessages()`,当前 UI 只显示 subagent 标签。
  等有人真的需要再说。
- **不做分页**。最大的 transcript 实测 388KB。超过阈值时截断并明确标注"已截断",
  而不是悄悄少显示。
