# Open Web Agents — 技术架构设计(架构师视角)

- 状态:草案(待 review)
- 日期:2026-07-26
- 关联:`2026-07-26-open-web-agents-design.md`(需求/产品蓝图)
- 本文范围:代码层面的**分层、模块划分、设计模式、核心抽象、依赖规则**

---

## 0. 架构目标与驱动力(Driving Forces)

| 目标 | 说明 | 架构手段 |
|---|---|---|
| **SDK 隔离** | claude-agent-sdk 会频繁升级、API 会变 | Anti-Corruption Layer + EnginePort,SDK 只出现在一个 adapter 里 |
| **可替换基础设施** | DB/Redis/存储/模型网关都可能换 | Ports & Adapters,基础设施全是可插拔 adapter |
| **可水平扩容** | 单机起步,后期 k8s | 队列 + 事件总线用端口抽象,worker 无状态 |
| **多租户安全** | 每用户 key、会话归属、沙箱 | 域层强制归属校验 + 边界处脱敏 + 执行隔离 adapter |
| **结构化输出契约** | 智能体 = 可被系统调用的接口 | 显式的 Schema/Result 抽象,贯穿域层 |
| **可测试** | 核心逻辑不碰 IO 即可单测 | 依赖倒置,域层纯逻辑,IO 在 adapter |

**反目标(YAGNI)**:不引入 DDD 聚合根/事件溯源/CQRS/重型 DI 容器/微服务拆分。保持单体 Next.js。

---

## 1. 架构总览:分层 + 六边形

```
                     ┌─────────────────────────────────────────────┐
                     │           Presentation(Next.js UI)          │  React Server/Client Components
                     │      工作台 / 智能体构建器 / 管理后台           │
                     └───────────────────────┬─────────────────────┘
                                              │ (fetch / SSE)
   ┌──────────── Driving Adapters(入站)─────┴───────────────────┐
   │  API route handlers  ·  对外 invoke API  ·  可嵌入 widget SDK │  把 HTTP/SSE ↔ 用例调用
   └───────────────────────────┬─────────────────────────────────┘
                               │ 调用 Application 用例(端口:输入)
   ┌───────────────────────────┴─────────────────────────────────┐
   │                   Application(用例编排层)                    │  无框架、无 IO 细节
   │   AgentService · SessionService · RunOrchestrator ·      │  只依赖「端口接口」
   │   IntegrationService · AccessService                         │
   └───────────────────────────┬─────────────────────────────────┘
                               │ 依赖倒置(依赖抽象端口,非实现)
   ┌───────────────────────────┴─────────────────────────────────┐
   │                     Domain(核心域)                          │  纯 TypeScript,零外部依赖
   │  实体/值对象: Agent · Session · Run · AgentEvent ·       │  可 100% 单测
   │  结果契约: OutputSchema · StructuredResult · VerifyRule      │
   │  纯逻辑: buildSpec() · 状态机 · 三级模型解析 · 事件归一规则   │
   └───────────────────────────┬─────────────────────────────────┘
                               │ 端口(Ports,interface 定义在域/应用层)
   ┌───────────────────────────┴─────────────────────────────────┐
   │              Driven Adapters(出站,实现端口)                │
   │  EnginePort→claude-agent-sdk   RepoPort→Drizzle/MySQL        │
   │  BusPort→Redis pub/sub         QueuePort→MySQL 租约          │
   │  StoragePort→本地/OSS          ModelGatewayPort→env/网关     │
   │  SandboxPort→OS 内核沙箱        SecretPort→加密/脱敏          │
   └───────────────────────────────────────────────────────────────┘
```

**依赖规则(铁律)**:箭头只能从外向内。Domain 不 import 任何 adapter / 框架 / SDK。Application 只 import Domain + 端口 interface。Adapter import 端口 interface 并实现之。**依赖注入靠一个 composition root**(`src/lib/container.ts`)手工装配,不用 DI 框架。

---

## 2. 模块划分(按领域纵切)

每个模块自带:`domain/`(实体+纯逻辑)、`application/`(用例)、`ports.ts`(接口)、`adapters/`(实现)。模块间**只通过 application 用例或端口**交互,不跨模块直接 import 内部实现。

| 模块 | 职责 | 关键端口/依赖 | 不负责 |
|---|---|---|---|
| **identity** | 用户、登录(NextAuth)、API Key、每用户凭证 | SecretPort, UserRepo | 业务权限判定(→access) |
| **access** | 通用授权(AccessGrant 表)、归属校验、角色 | GrantRepo | 认证(→identity) |
| **agent** | 智能体定义、config、input/output schema、`buildSpec` | AgentRepo | 运行(→run) |
| **session** | 会话(=项目=工作目录)生命周期、resume 上下文、工作目录分配 | SessionRepo, StoragePort | agent 执行(→engine) |
| **agent-engine** | **唯一**封装 claude-agent-sdk:query 循环、options 组装、消息归一、结构化输出、沙箱 | EnginePort, SandboxPort, ModelGatewayPort | 队列/持久化(→run) |
| **run** | 运行编排、状态机、队列、worker、租约、孤儿回收 | QueuePort, RunRepo, EnginePort, BusPort | SDK 细节(→engine) |
| **events** | 事件归一后的发布/订阅、SSE 编帧、双缓冲重放、脱敏 | BusPort, SecretPort | 产生事件(→engine) |
| **artifacts** | 工作目录文件树/预览/下载、产物收集、GC | StoragePort | 事件(→events) |
| **integration** | 对外 invoke、结果获取(poll/sse/webhook)、API Key 鉴权入口 | 复用 run + access | UI(→presentation) |

**模块依赖图(无环)**:
```
presentation → integration/session/agent/access/identity
integration → run → agent-engine → (engine/sandbox/model ports)
run → events → (bus port)
session/agent/run → artifacts → (storage port)
所有模块 → access(校验) / identity(凭证)
```

---

## 3. 设计模式选型(每个都为解决具体问题,不为炫技)

| 模式 | 用在哪 | 解决什么 |
|---|---|---|
| **Ports & Adapters(六边形)** | 全局:engine/repo/bus/queue/storage/model/sandbox | 基础设施可替换 + 域层可测 |
| **Anti-Corruption Layer** | agent-engine 的 `normalizeEvent`:SDK 消息 → 域内 `AgentEvent` | SDK 升级/变更不外溢到业务 |
| **Builder** | `buildSpec(AgentConfig, RunContext) → AgentSpec` | 分层优先级组装(默认<spec<会话<invoke override) |
| **Strategy** | ModelResolver(三级 key/base_url)、ResultDelivery(poll/sse/webhook)、Storage(local/oss) | 同一入口多种可切换算法 |
| **State Machine** | Run:`pending→running→success/failed/cancelled` | 状态迁移合法性集中管控,防非法态 |
| **Producer–Consumer + Lease** | run 队列:MySQL 乐观锁认领 + 租约续期 + 孤儿回收 | 零中间件的可靠异步任务 |
| **Publisher–Subscriber** | events:Redis pub/sub | web(SSE)与 worker 跨进程解耦(替换单进程红线) |
| **Repository** | 各 `*Repo` 端口 | 隔离 Drizzle,数据访问可测/可换 |
| **Command** | `InvokeCommand` / `SendMessageCommand` 进 RunOrchestrator | 人用对话与系统 invoke **共用同一运行内核** |
| **Facade** | Application 各 Service 对 route handler 暴露粗粒度用例 | route 只做 HTTP↔用例转换,薄 |
| **Decorator/Middleware** | engine 的 hooks(如强制子代理同步)、事件脱敏 | 横切行为不侵入主流程 |

---

## 4. 核心抽象(端口接口草图)

> 仅签名示意,细节实现阶段定。所有端口 interface 定义在域/应用层,adapter 在基础设施层实现。

```ts
// ── agent-engine 端口:唯一与 SDK 接触的边界 ──────────────
interface EnginePort {
  // 跑一轮:内部 query()+resume,把 SDK 消息归一成域事件回调
  run(spec: AgentSpec, ctx: RunContext, onEvent: (e: AgentEvent) => void,
      signal: AbortSignal): Promise<RunResult>;
}

interface AgentSpec {                        // 域内契约,不含任何 SDK 类型
  systemPrompt: string;
  skills?: string[]; mcpServers?: McpDef[]; tools?: ToolDef[]; subagents?: SubagentDef[];
  model: ModelSelection;                     // 别名 fable/opus/sonnet/haiku + 解析后的实际值
  outputSchema?: JsonSchema;                 // 有则启用结构化输出
  verifyRules?: VerifyRule[];
  limits: { maxTurns?: number; effort?: Effort };
  escapeHatch?: Record<string, unknown>;     // 逃生舱,最后 spread
}

interface RunContext {
  workspaceDir: string;                      // 绝对路径,每会话独立
  resumeSessionId?: string;
  credentials: ResolvedCredentials;          // 三级解析后的 base_url/key
  env: Record<string, string>;
}

// ── 归一后的域事件(SSE 与 jsonl 回放共用)────────────────
type AgentEvent =
  | { kind:'text'|'thinking'; text:string; subagent?:string }
  | { kind:'tool_use'; tool:string; input:unknown; toolUseId?:string; subagent?:string }
  | { kind:'tool_result'; toolUseId?:string; text:string; isError?:boolean; subagent?:string }
  | { kind:'status'; label:string; state?:string }
  | { kind:'artifact'; path:string; mime:string; url?:string }
  | { kind:'usage'; messageId?:string; input:number; output:number }
  | { kind:'result'; status:'success'|'failed'; structured?:unknown; summary?:string };

// ── 基础设施端口 ─────────────────────────────────────────
interface RunRepo { create(r:NewRun):Promise<Run>; claimNext(lease:number):Promise<Run|null>;
  touch(id:string):Promise<void>; complete(id:string, r:RunResult):Promise<void>;
  reclaimOrphans():Promise<number>; }
interface BusPort { publish(topic:string, e:AgentEvent):Promise<void>;
  subscribe(topic:string, cb:(e:AgentEvent)=>void):Unsubscribe; }
interface StoragePort { workspacePath(sessionId:string):string; tree(dir:string):Promise<FileNode[]>;
  read(p:string):Promise<Buffer>; put(p:string):Promise<string>/*url*/; gc(sessionId:string):Promise<void>; }
interface ModelGatewayPort { resolve(sel:ModelSelection, creds:CredentialChain):ResolvedCredentials & {modelId:string}; }
interface SandboxPort { materialize(cfg:SandboxCfg):{ sandbox:unknown; disallowedTools:string[] } | null; }
interface SecretPort { encrypt(v:string):string; decrypt(v:string):string; redact(text:string):string; }

// ── 纯逻辑(域层函数,可直接单测)──────────────────────────
function buildSpec(a: AgentConfig, ctx: RunContext): AgentSpec;    // Builder
function resolveModel(chain: CredentialChain): ResolvedCredentials;    // 三级 Strategy
function nextRunState(cur: RunState, ev: RunSignal): RunState;         // State Machine
function normalizeSdkMessage(msg: unknown): AgentEvent[];              // ACL(在 engine adapter 内)
```

---

## 5. 关键流程的架构落点

### 5.1 人用对话一轮(多轮 loop)
```
UI ──POST /api/sessions/{id}/run──▶ [API adapter]
   → SessionService.sendMessage(cmd)         (Application)
   → RunOrchestrator.enqueue(Run:pending)    (State Machine: →pending)
   ─ ─ ─ 异步解耦 ─ ─ ─
   worker ─claimNext(lease)─▶ RunOrchestrator.execute()   (→running)
     → buildSpec(agent, ctx)             (Builder, 域纯逻辑)
     → EnginePort.run(spec, onEvent)          (SDK adapter: query()+resume)
         每个 SDK 消息 → normalizeSdkMessage → AgentEvent   (ACL)
         → SecretPort.redact → BusPort.publish(topic=sessionId)   (Pub/Sub)
     → RunResult(structured?) → RunRepo.complete   (→success/failed)
UI ◀─SSE /api/sessions/{id}/events─ [SSE adapter] ◀─ BusPort.subscribe
   (断线重连:joinStream = 重新 subscribe + 双缓冲重放 state 事件)
```

### 5.2 系统 invoke(与 5.1 共用同一内核)
```
第三方 ──POST /api/agents/{aid}/invoke (X-Api-Key)──▶ [API adapter]
   → IntegrationService.invoke(cmd)
   → AccessService.assertApiKey(key, agent)      (鉴权+归属)
   → 复用 RunOrchestrator(创建会话+入队)  ← 同一 Command 入口
   → ResultDelivery(Strategy): poll GET /result | SSE /events | webhook 回调
```

**关键**:5.1 与 5.2 只有「入站 adapter + 鉴权 + 结果投递」不同,**运行内核(Orchestrator/Engine/Bus)完全复用**——落实 §3 设计文档的"统一接口原则"。

---

## 6. 目录结构(模块 → 目录映射)

```
src/
├─ app/                                   # Presentation + 入站 adapter
│  ├─ (workbench)/  (builder)/  (admin)/  # UI
│  └─ api/
│     ├─ sessions/[id]/(run|events|files)/route.ts     # 薄:HTTP↔用例
│     ├─ agents/…  auth/…
│     └─ agents/[aid]/invoke · [taskId]/(result|events)/route.ts
├─ lib/
│  ├─ container.ts                        # composition root(手工装配端口→adapter)
│  ├─ modules/
│  │  ├─ identity/     { domain/ application/ ports.ts adapters/ }
│  │  ├─ access/       { … }
│  │  ├─ agent/    { domain/{config,schema,buildSpec}.ts application/ ports.ts }
│  │  ├─ session/      { … }
│  │  ├─ agent-engine/ { domain/{event,spec}.ts application/ ports.ts
│  │  │                  adapters/claude-sdk/{runner,normalize,options,sandbox}.ts }
│  │  ├─ run/          { domain/{state-machine}.ts application/orchestrator.ts
│  │  │                  adapters/{mysql-queue,worker}.ts }
│  │  ├─ events/       { adapters/{redis-bus,sse,replay-buffer}.ts }
│  │  ├─ artifacts/    { adapters/{local-fs,oss,gc}.ts }
│  │  └─ integration/  { application/{invoke,delivery}.ts }
│  ├─ db/              # Drizzle schema + 迁移(RepoPort 的实现落这里)
│  └─ shared/          # 跨模块纯类型/工具(无 IO)
├─ features/           # 前端特性组件(chat 渲染内核、文件面板、builder 表单)
└─ components/         # shadcn/ui + 通用 UI
```

---

## 7. 可测试性策略

| 层 | 测什么 | 怎么测 |
|---|---|---|
| Domain | buildSpec / 状态机 / 模型三级解析 / 归一规则 | 纯单测,零 mock |
| Application | 用例编排(如 orchestrator 认领→执行→完成) | mock 端口(内存 fake) |
| Adapter | SDK 归一、队列租约、SSE 编帧 | 针对性集成测(fake SDK 消息、真 MySQL/Redis 容器) |
| E2E | 造智能体→跑会话→拿结构化结果闭环 | 少量,覆盖关键路径 |

**关键杠杆**:所有端口都有一个 `InMemory*` fake 实现,application 层测试不碰真 IO;agent-engine 用**录制的 SDK 消息序列**回放测归一,不真调模型。

---

## 8. 扩展点(Open for Extension)

- **新智能体能力** → 加 skill/mcp/tool 到 AgentConfig,`buildSpec` 无需改
- **新存储后端** → 实现 StoragePort(已规划 local/oss)
- **新结果投递** → 加 ResultDelivery strategy(poll/sse/webhook 之外)
- **新模型网关** → 实现 ModelGatewayPort
- **换掉 SDK** → 只重写 agent-engine 的一个 adapter,域/应用层零改动(ACL 的回报)
- **执行隔离升级** → SandboxPort 从「OS 沙箱」换「容器/Firecracker」不动业务

---

## 9. 关键架构权衡与风险

1. **六边形的前期成本**:端口/adapter 样板更多。缓解:只对**真正会变**的 7 个依赖建端口,纯 CRUD 不过度抽象。
2. **单体内的模块边界靠约定**:TS 无强模块可见性。缓解:ESLint 依赖边界规则(禁跨模块 import 内部)+ 目录约定 + composition root 统一装配。
3. **worker 与 web 同镜像**:MVP 单进程 Docker;但代码上 worker 入口独立、无本地状态,拆进程只改部署不改码。
4. **事件顺序与丢失**:Redis pub/sub 不保证持久。缓解:state 类事件双缓冲重放 + jsonl 终态回放兜底 + poll 兜底。
5. **归一层是 SDK 变更的唯一缓冲**:必须有录制回放测试守护,SDK 升级先跑归一测试。

---

## 10. 与需求文档的一致性对照

| 需求(design.md) | 架构落点 |
|---|---|
| 统一接口原则 | §5 人用/系统用共用 RunOrchestrator + Command |
| 可选结构化输出 | AgentSpec.outputSchema + ResultSink,域层可选字段 |
| 会话=项目=工作目录 | session 模块 + StoragePort.workspacePath(sessionId) |
| 三级模型覆盖 | ModelGatewayPort + resolveModel Strategy |
| Redis 事件总线 / 可扩容 | BusPort→redis-bus,worker 无状态 |
| SDK 隔离 / 全新实现 | agent-engine 单一 adapter + ACL |
| 每用户 key / 脱敏 / 归属 | SecretPort + AccessService |
```
