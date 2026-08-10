# 架构偏离记录

`docs/superpowers/specs/` 里的两份设计文稿是**动工前**写的,原样保留、不回填修改 ——
它记录的是当时的判断,改掉它就抹掉了"我们后来知道了什么"。

代码与文稿不一致的地方记在这里,**每条都写清楚为什么**。
没有理由的偏离不该存在;有理由但不记录的偏离,会让下一个人对照文档读代码时怀疑自己。

核对方式:写脚本机械比对(模块目录、端口 interface 名、扩展点、一致性表、MVP 清单),
不凭印象。下面每条都实际验证过落点。

---

## A. 端口:文稿列了、代码里没有同名 interface

**共同判断依据**:端口的价值是"隔离真正会变的依赖"。纯逻辑没有依赖可隔离,
为它建端口只是多一层间接。README 里"只对真正会变的依赖建端口"就是指这个。

### A1. `SandboxPort` → `materializeSandbox` 纯函数

- 文稿:`interface SandboxPort { materialize(cfg): { sandbox, disallowedTools } | null }`
- 实际:`agent-engine/domain/sandbox.ts` 的 `materializeSandbox(policy): MaterializedSandbox`
- **理由**:它只做路径展开与配置组装,**零 IO**。返回结构与文稿一致,只是没包成 interface。
- **代价(真实存在)**:文稿 §8 说"SandboxPort 从 OS 沙箱换容器/Firecracker 不动业务"。
  容器沙箱要拉镜像、起容器,是有 IO 的 —— **那一天来了必须先把它提成端口**。
  现在不提,是因为容器沙箱没做(见 README 已知限制),提前抽象只会抽错。

### A2. `SecretPort` → `SecretBox` 类 + `redactSecrets` 纯函数

- 文稿:`interface SecretPort { encrypt; decrypt; redact }`
- 实际:`identity/domain/secret-box.ts` 的 `SecretBox`(encrypt/decrypt,持有主密钥)
  + `agent-engine/domain/redact.ts` 的 `redactSecrets`(纯函数)
- **理由**:加解密需要主密钥,是有状态的;脱敏只是字符串替换,不需要密钥。
  捏在一个端口里,会逼着每个只想脱敏的调用方去拿一个它不需要的密钥。
  两者的**变更原因也不同**:换加密算法与加脱敏规则是两件事。

### A3. `QueuePort` → 并入 `RunRepo`

- 文稿:同时列了 `QueuePort` 与 `RunRepo`
- 实际:队列语义(`claimNext` / `touch` / `complete` / `reclaimOrphans`)就在 `RunRepo` 上
- **理由**:队列与运行记录**是同一张 MySQL 表**。拆两个端口指向同一份数据,
  会让"认领"和"落终态"看起来可以各自替换,而实际上它们必须共享同一套事务与
  栅栏语义(见 A4)。一个端口反而更诚实。

### A4. `RunRepo` 的签名比文稿多了参数

| 文稿 | 实际 | 为什么 |
|---|---|---|
| `claimNext(lease)` | `claimNext(leaseMs, now)` | `now` 注入才能对租约过期做确定性测试,不靠 sleep |
| `touch(id)` | `touch(id, leaseUntil, fence): Promise<boolean>` | 返回值是 worker 察觉失租的**唯一**信号;fence 挡住僵尸 worker 写库 |
| `complete(id, r)` | `complete(id, state, fence): Promise<boolean>` | 同上;返回 false = 没写进去(已终态或已失租) |

这三处不是风格差异,是**踩过之后加的**:原来的形态下,同一个任务会被两个 worker
执行两次,且早已被判定为孤儿的那个还能覆写接手者的结果。详见提交
`fix(queue): 栅栏令牌 —— 堵住同一任务被两个 worker 执行`。

---

## B. 落点与命名不同

| 文稿 | 实际 | 为什么 |
|---|---|---|
| `StoragePort.workspacePath(sessionId)` | `session/domain/workspace.ts` 的 `workspacePathFor(dataDir, sessionId)` | "会话的工作目录在哪"是**会话**的知识,不是存储后端的。放存储里会让换存储后端时被迫搬走一段与存储无关的路径规则 |
| `StoragePort.gc(sessionId)` | `artifacts/application/gc.ts` 的 `WorkspaceGc` | GC 是**策略**(留多久、先清中间产物还是整目录),不是存储原语。它要读运行活动数据才能决策,属于用例层 |
| `StoragePort.put(p): url` | 不存在 | 只有本地文件系统一个实现,没有"上传到对象存储换 URL"的场景。**等真接 OSS 时再加**,现在加就是猜 |
| `AccessService` | `access/application/authorize.ts` 的 `Authorizer` | 纯命名。它只做判定不做编排,`Authorizer` 更准确 |
| `ResultSink` | 不存在 | 结果投递没做成统一抽象,见 C1 |
| `resolveModel(chain)` | `resolveCredentials` + `resolveModelAlias` | 凭证解析与模型别名解析是两条独立的回退链(`baseUrl` 与 `key` 各自回退),合成一个函数会把两套规则搅在一起 |

---

## C. 文稿列了但没做

### C1. ResultDelivery 没做成 Strategy

- 文稿 §3 把 `ResultDelivery(poll/sse/webhook)` 列为 Strategy 模式的用武之地
- 实际:三种投递各自实现 —— poll 在 `/api/agents/{id}/result`,sse 在 run/events 路由,
  webhook 是编排层的 `onComplete` 回调
- **理由**:三者的**触发时机与生命周期完全不同**(poll 是调用方拉、sse 是长连接推、
  webhook 是终态一次性推),硬套同一个接口会造出一个每个实现都用不满的抽象。
- **什么时候该改**:出现第四种投递方式(如消息队列)、且它与现有三种共享真实逻辑时。

### C2. 容器级沙箱

见 README「已知限制」——开发机没有 Docker,写了无法验证的隔离代码比不写更糟。

### C3. 模块依赖边界:不是 ESLint 规则,是测试

- 文稿 §9 缓解措施里写了"ESLint 依赖边界规则(禁跨模块 import 内部)"
- 实际:项目用 Biome,而它的 `noRestrictedImports` 只认精确模块名,
  表达不了 `@/lib/modules/*/adapters/**` 这种形态。
- **改成机械检查**:`src/lib/__tests__/architecture.test.ts` 随 `pnpm test` 跑,
  读源码文本判断,不需要起服务:

  | 规则 | 守住什么 |
  |---|---|
  | `domain/**` 与 `shared/**` 不 import next / drizzle / ioredis / mysql2 / SDK | 纯逻辑可 100% 单测这条前提 |
  | 模块间只经 `ports` / `application` / `domain`,不碰别人的 `adapters/` | "换实现只改 container" |
  | 恰好一个文件 import SDK | README 的硬声明与 ACL 的前提 |
  | `app/` 路由不直接 `new Mysql*/Redis*/LocalFs*/InMemory*` | 装配点唯一 |

- **验证过它真的会拦**:逐条注入违规(domain 里加 drizzle、跨模块 import adapters、
  第二个文件 import SDK、路由里 new 具体实现),四条都如期变红,恢复后回到全绿。
  一条从不触发的检查等于没有。
- 另有两条"数量下限"断言,防止目录拼错时检查零违规空转 —— 那种永远绿的检查最危险。

---

## D. 文稿模块表没列、但实际存在的模块

`approval`(HITL)、`knowledge`(检索)、`usage`(用量)、`model-gateway`(别名槽)。

前三个在 `design.md` 里都有出处(§12 二期清单),只是架构文稿的模块表写于
MVP 范围内,没有前瞻到二期;`model-gateway` 则是文稿 §4 就有的 `ModelGatewayPort`,
只是模块表漏列。**不是自行加的功能。**

---

## E. 历史回放读 SDK 的 jsonl,而不是自建事件表

设计文稿里过程事件只有两个去处:Redis 事件总线与 `ReplayBuffer`。两者都是易失的 ——
运行一结束过程就不可恢复,用户刷新页面看到一片空白。

**没有新建 `run_events` 表**,而是加了 `TranscriptPort`(`agent-engine/ports.ts`)
去读 SDK 自己写的 jsonl(`dataDir/.agent-home/.claude/projects/<编码 cwd>/<sdkSessionId>.jsonl`)。

- **理由**:SDK 本来就把完整过程落了盘 —— thinking / tool_use / tool_result / text / usage 全在
  (对真实文件核对过)。再建一张表就是把同一份数据存两遍,还要维护写入一致性、保留期与
  体积上限。而 `normalizeSdkMessage` 读的正是 `m.type` + `m.message`,与 jsonl 行同构,
  **一份归一逻辑同时服务实时流与历史回放**,SDK 变更只有一处要改。
- **什么时候该改回去**:若要按内容检索历史(全文搜工具调用、跨会话统计),
  或 transcript 必须跨机共享而又不想上共享卷 —— 前者需要索引,后者该换成 SDK 的
  `SessionStore` 适配器(见 `sdk-docs/session-storage.md`),端口不变、换实现即可。

### E1. 分工:runs 表定骨架,jsonl 填血肉

轮次顺序、提示词、runId、分支来源全部取自 `runs` 表;jsonl 只提供过程事件。
jsonl 里虽然也有用户提示词,但从中反推轮次边界既脆弱又多余 —— SDK 换个写法就散架,
而 runs 表本来就精确记着这些。

### E2. 活跃轮【刻意不读】transcript

`history.ts` 对仍在跑的那一轮只回提示词,事件留空,由 `/events` 实时推。

这不是性能优化,是**让「不重复」成为结构上的必然**:`AgentEvent` 没有唯一 id,
真让同一批事件从两条路进来,前端去不了重。两个来源各管一段就不存在这个问题。
(另外该轮的 `sdkSessionId` 此刻多半还没落库 —— 它在运行结束时才写。)

### E3. 三条已知限制

| 限制 | 影响 | 何时该处理 |
|---|---|---|
| 子代理归属丢失 | jsonl 用 `isSidechain` 标记子代理,而归一层读的是 `parent_tool_use_id`(jsonl 里没有)。回放时子代理输出以主 agent 身份呈现,信息不丢、少了标签 | 用户开始依赖子代理分组来读历史时 |
| 活跃轮开头可能缺失 | 分进程部署(`OWA_EMBEDDED_WORKER=0`)下 ReplayBuffer 为空,活跃轮开头要等它跑完、刷新后才从 jsonl 看到。默认内嵌 worker 不受影响 | 正式采用分进程部署时,与 ReplayBuffer 换 Redis 一并做 |
| jsonl 无限增长 | 工作空间 GC 只清 `dataDir/workspaces/`,不覆盖 `.agent-home` | 长期运行的部署占盘变明显时 |

### E4. 路径编码规则只对 `/` 与 `.` 有实证

`projectDirNameFor` 把 `/` 与 `.` 都替换成 `-`。**点这一条是踩过之后加的**:
原本只替换分隔符,于是 `.claude` 推成 `-.claude`,而 SDK 写的是 `--claude` ——
含点的路径整份读不到,表现是**历史一片空白、零报错**。
反例取自本机盘上真实存在的目录(worktree 的 cwd 含 `.claude`),已写进测试钉死。

不需要改代码就能踩到:`OWA_DATA_DIR=/srv/app.v2/data` 这样的部署配置即可。

**尚无实证的是空格、中文等字符** —— SDK 是否另有替换规则不得而知。
所以 `JsonlTranscript` 读不到文件时会扫一眼 `projects` 目录:
同名 jsonl 若躺在别的目录下,`console.warn` 指出实际目录名。
只在已经读不到的路径上跑,正常情况零开销;扫盘自身失败一律忽略。

- **为什么留探针而不是穷举规则**:SDK 的编码规则不是公开契约,穷举只能靠反例,
  而反例要等真实路径出现才有。探针把"静默空白"变成"日志里有线索" ——
  这是规则未知时能做的最有价值的事。
- **什么时候该改**:探针报出新字符,就补进 `projectDirNameFor` 并加测试;
  若改用 SDK 的 `SessionStore`(见 E 节),整套路径推导连同探针一起作废。

---

## 维护约定

改动如果与文稿不一致,就在这里加一条,写清楚**为什么**以及**什么时候该改回去**。
只有理由、没有"何时失效"的偏离,几年后没人敢动。
