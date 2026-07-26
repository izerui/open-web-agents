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

## 维护约定

改动如果与文稿不一致,就在这里加一条,写清楚**为什么**以及**什么时候该改回去**。
只有理由、没有"何时失效"的偏离,几年后没人敢动。
