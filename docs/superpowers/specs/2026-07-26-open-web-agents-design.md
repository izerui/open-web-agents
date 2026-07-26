# Open Web Agents — 设计文档

- 状态:草案(待用户 review)
- 日期:2026-07-26
- 作者:与 Claude 结对梳理

---

## 1. 背景与定位

### 1.1 一句话定位

一个基于 **claude-agent-sdk** 的智能体平台:可视化地定义**特定场景的专用助手**(如"视频生成助手""课程设计助手");每个助手都对外提供**一套统一接口**,调用方能拿到 **① 运行过程监控 + ② 结构化输出结果**,从而对接企业应用——既支持后台接口(Java/Go/Python/C)对接,也支持企业前端 chatbot 集成。

### 1.2 为什么做(差异化)

Claude app / Codex / AionUi / LobeHub 都是**通用智能体**:什么都能干,但产出是**对话文本**,无法直接喂给企业应用系统。

本项目做的是**可自定义的专用场景平台**:

- **通用引擎做底座**(claude-agent-sdk 白送多轮、工具执行、文件系统、子 agent、Skills、MCP)。
- **让企业自己"造员工"**:每个助手 = 一个只干特定某件事的专精员工,有自己的提示词、技能、MCP、工具、模型,以及**可选的结构化输出契约**。
- **员工既能人用、也能被系统调用**:同一套接口,网页对话 / 可嵌入 widget / 第三方后端调用,都是这个接口的客户端。

### 1.3 心智模型

| 比喻 | 对应 |
|---|---|
| 一家公司 | 平台 |
| 一个员工 / 岗位 | 助手 Assistant(模板) |
| 员工的大脑与通用能力 | claude-agent-sdk 引擎 |
| 岗位职责 + 专业技能 + 工具 | 助手配置(prompt/skills/mcp/tools) |
| 派员工干一次活 | 会话 Session / 一次运行 Run |
| 借调员工进业务系统干活 | 对外 API / 嵌入 widget |

### 1.4 设计原则:全新实现,只借鉴功能与设计

- **这是一个全新项目**,按本文档要求从零设计一整套**前端 + 后台**。
- 五个参考项目(question-bank / simple-agents / agent-chat-ui / langgraph-react-chatbot / open-webui)**只参考其功能与交互/架构设计**,**代码一律不复刻**——不 fork、不搬运组件、不继承其技术债。凡下文出现"借鉴/参考某项目的 X",一律指**重新实现**该能力。
- **前后端同一个 Next.js 全栈项目**(单仓库):UI 页面与 API route handlers 同处一个工程,不拆分独立前端/后端服务。

---

## 2. 核心概念模型(术语表)

| 概念 | 含义 | 关键字段 |
|---|---|---|
| **User** | 平台用户(人) | 角色 admin/user;自带 Anthropic key |
| **Assistant(助手/模板)** | 可配置的专用 agent 定义,平台核心一等公民 | name/icon/description、systemPrompt、skills、mcpServers、tools、subagents、model、capabilities、**inputSchema(可选)**、**outputSchema(可选)**、verifyRules(可选)、accessControl |
| **Project(项目)** | 组织容器,可带共享上下文/知识 | name、systemPrompt(可选)、knowledge(可选) |
| **Session(会话)** | 用某助手发起的一次运行实例 | assistantId、projectId、workspaceDir、状态、sdkSessionId(resume 用) |
| **Message** | 会话内的一条消息(user/assistant/tool 等) | role、content、事件序列 |
| **Run / Task** | 会话内一轮 agent 执行(query()+resume) | status、结构化结果、cost/usage、产物列表 |
| **Artifact(产物)** | 工作空间里生成的文件 | path、mime、size、下载 URL |
| **StructuredResult** | 按助手 outputSchema 校验后的 JSON | 仅当助手定义了 outputSchema 时存在 |
| **ApiKey** | 对外调用凭证 | 归属助手/用户、配额、scope |
| **AccessGrant** | 通用授权记录 | resourceType、resourceId、principal(user/group/*)、permission(read/write) |

---

## 3. 统一接口原则(本项目最关键的设计决策)

**不区分"人用"和"系统用",只有一套统一的"助手运行接口"。**

- 网页对话、可嵌入 widget、第三方后端(Java/Go/Python/C),都是**同一个运行接口的不同客户端**,后端不分两套。
- **人用 vs 系统用的唯一区别 = 助手是否定义了 `outputSchema`**:
  - **特定助手**(定义了 outputSchema):运行结束返回**结构化 JSON 结果**(系统可直接消费)+ 全程过程可监控。
  - **通用助手**(未定义 outputSchema):只能拿到最终完成的**对话文本**,无结构化结果。
- 因此 `outputSchema` 是助手的一个**可选能力**,在**构建助手时定义**;它决定了这个助手能不能被企业系统当"接口"用。

这条原则直接决定 API 设计:**一套 session/run 内核 + 一套统一 API + 助手级可选 outputSchema**,而不是 chat API 与 invoke API 各一套。

---

## 4. 系统架构(分层)

```
┌─ 消费层(统一接口的多种客户端)───────────────────────────┐
│  Web 工作台(人)  │  可嵌入 chat widget  │  第三方后端(API Key)  │
├─ 应用层  Next.js App Router ────────────────────────────┤
│  页面:工作台 / 助手构建器 / 管理后台                         │
│  route handlers(统一运行接口 + 资源 CRUD):                 │
│    /api/assistants·sessions                   (CRUD)       │
│    /api/sessions/{id}/run    (发起一轮运行,SSE 流式)        │
│    /api/sessions/{id}/files  (工作空间文件树/预览/下载)      │
│    /api/agents/{assistantId}/invoke  (对外触发=创建会话+运行)│
│    /api/agents/{taskId}/result | /events | webhook          │
│  双鉴权:人类 session(NextAuth) ‖ 对外 API Key             │
├─ Agent 引擎层(question-bank agent-engine 的通用化)──────┤
│  · buildSpec:从「助手配置」动态构建 AgentSpec               │
│  · runner:query()+resume 多轮消息循环                       │
│  · normalizeEvent:SDK 消息 → 统一事件 + redactSecrets 脱敏  │
│  · 结构化输出:outputFormat(json_schema)+zod + verifyResult │
│  · 每会话 cwd 工作空间 + OS 内核沙箱(seatbelt/bubblewrap)  │
│  · claude-agent-sdk(每用户 key 注入 ANTHROPIC_*)           │
├─ 任务/队列层 ───────────────────────────────────────────┤
│  · MySQL 当队列 + 租约乐观锁认领 + 孤儿任务回收             │
│  · 事件总线:Redis pub/sub(替换 question-bank 的单进程红线)│
│  · worker 池(并发可配,支持独立进程/水平扩容)              │
├─ 数据层  MySQL + Drizzle ───────────────────────────────┤
│  users / assistants / sessions / messages /               │
│  runs / artifacts / api_keys / access_grants / user_valves │
├─ 存储层 ────────────────────────────────────────────────┤
│  会话工作空间(本地磁盘 / 阿里云 OSS)                       │
│  jsonl transcript 回放(复用 SDK 自带持久化,固定 HOME/cwd) │
└──────────────────────────────────────────────────────────┘
```

---

## 5. 数据模型(初稿,Drizzle + MySQL)

> 字段仅列关键项,细节在实现阶段补全。JSON 列用于承载灵活配置。

- **users**: id, email, passwordHash, role(admin/user), defaultBaseUrl?, anthropicKeyEnc(加密), createdAt
- **assistants**: id, ownerId, name, icon, description, config(JSON: systemPrompt/skills/mcpServers/tools/subagents/model/capabilities/effort/maxTurns), inputSchema(JSON?), outputSchema(JSON?), verifyRules(JSON?), webhookUrl?, visibility, createdAt, updatedAt
- **sessions**(= 项目 = 工作目录,一对一): id, assistantId, ownerId?(人用时), callerApiKeyId?(系统用时), workspaceDir, sdkSessionId?, title, status, baseUrl?/keyEnc?/model?(会话级覆盖), createdAt
  - _无独立 projects 表;分组文件夹层留待二期_
- **messages**: id, sessionId, role, content(JSON), createdAt
- **runs**: id, sessionId, status(pending/running/success/failed/cancelled), leaseUntil, structuredResult(JSON?), cost(JSON), errorInfo?, startedAt, endedAt
- **artifacts**: id, sessionId, path, mime, size, storageUrl, createdAt
- **api_keys**: id, assistantId?, ownerId, hashedKey, name, quota(JSON), lastUsedAt, createdAt
- **access_grants**: id, resourceType, resourceId, principalType(user/group/*), principalId, permission(read/write)
- **user_valves**: id, userId, toolId, config(JSON) — 工具级每用户配置

---

## 6. Agent 引擎(基于 claude-agent-sdk)

借鉴 question-bank 的 `agent-engine` 分层思路(通用引擎 / 业务解耦)**全新实现**,并从助手配置动态构建,而非写死。

### 6.1 从助手配置动态构建 AgentSpec

```
Assistant.config ──buildSpec()──▶ AgentSpec {
  systemPrompt, skills, mcpServers, tools, subagents,
  model, effort, maxTurns,
  resultSchema?(= outputSchema, 有则启用 outputFormat),
  verifyResult?(= verifyRules),
  sdkOptions(逃生舱)
}
```

### 6.2 运行模式

- **多轮**:`query({ prompt, options: { resume: sdkSessionId, cwd: workspaceDir, ... } })`;每条用户消息 resume 上一轮 session。
- **中断**:AbortController(经 Redis 广播 taskId → worker abort)。
- **续流**:参考 langgraph-react-chatbot 的 joinStream——刷新/断线重挂正在跑的 run。
- **MVP 暂不做** streaming input"运行中插话",只支持"中断"。

### 6.3 安全与隔离

- `permissionMode: bypassPermissions` + **OS 内核沙箱**(`failIfUnavailable: true`,绝不裸跑)取代工具白名单。
- `disallowedTools` 挡宿主进程侧 Read/Edit/Write 越界;沙箱 denyRead 内核禁读 `~/.ssh` 等。
- 事件归一层 `redactSecrets()` 脱敏,防 key 泄露到前端/日志。
- 每会话独立 `cwd`(绝对路径),`HOME` 固定到共享 `.agent-home`(缓存复用 + jsonl 回放定位)。

### 6.4 结构化输出与验收

- `outputFormat: { type: "json_schema", schema: zodToJsonSchema(outputSchema) }`。
- 运行结束 `structured_output` 经 zod `safeParse` 校验后入库。
- 可选 `verifyResult` 机械验收(如产物文件存在、时长校验),防 agent 伪造成功。

---

## 7. 统一运行 API + SSE 事件契约

### 7.1 统一事件类型(归一后,服务 SSE 与 jsonl 回放同一套)

```ts
type AgentEvent =
  | { kind: "text";        text: string; subagent?: string }
  | { kind: "thinking";    text: string; subagent?: string }
  | { kind: "tool_use";    tool: string; input: unknown; toolUseId?: string; subagent?: string }
  | { kind: "tool_result"; toolUseId?: string; text: string; isError?: boolean; subagent?: string }
  | { kind: "status";      label: string; state?: string }   // 过程监控(open-webui 风)
  | { kind: "artifact";    path: string; mime: string; url?: string }
  | { kind: "usage";       messageId?: string; inputTokens; outputTokens; ... }
  | { kind: "result";      status: "success"|"failed"; structured?: unknown; summary?: string };
```

### 7.2 SSE 传输

- 裸 `data: <JSON of AgentEvent>\n\n`;头含 `X-Accel-Buffering: no`。
- 前端用 `fetch + getReader()` 手工拆帧(需带 Authorization,不能用原生 EventSource)。
- state 类事件(status/task/artifact/result/usage)全留,noise 类(text/thinking/tool)滚动淘汰——供断线重连重建。

### 7.3 对外调用(第三方系统)

```
POST /api/agents/{assistantId}/invoke      (Header: X-Api-Key)
  body: {
    input: <符合 inputSchema>,
    override?: { base_url?, key?, model? }   // 请求级覆盖(三级最高优先)
  }
  → 200 { taskId }                          // 异步

GET  /api/agents/{taskId}/result           // 轮询:pending / success{structured, artifacts[]} / failed
GET  /api/agents/{taskId}/events           // SSE:实时过程监控
POST webhook(可选,助手配置回调地址)        // 完成时推 { taskId, status, structured, artifacts }
```

三种拿结果方式(轮询 / SSE / webhook)按需启用。

---

## 8. 对外集成(企业对接)

- **后台接口对接**(Java/Go/Python/C):`invoke` + `result`/`webhook`,拿结构化 JSON。
- **前端 chatbot 集成**:可嵌入 widget(参考 langgraph-react-chatbot 形态),但**鉴权改为服务端 BFF 代理注入**,不把 key 下发浏览器。
- **鉴权分层**:平台内人类走 NextAuth session;对外调用走 per-助手/per-调用方 API Key + 配额。

---

## 9. 多用户与权限

- 角色:admin / user。
- **通用 AccessControl**(open-webui 范式):一张 `access_grants` 表 + 一个前端组件,覆盖 assistants/projects/sessions;`*` = public。
- **每用户自带 Anthropic key**:加密入库,运行时注入 agent 子进程 env,`redactSecrets` 防泄露。
- **会话归属校验**:SSE/文件/结果接口必须校验 caller 是否有权访问该 session(question-bank 的短板,必补)。
- **Valves / UserValves**:工具级双层配置(admin 全局 + 每用户)。

---

## 10. 从五个参考借鉴什么(全新实现,不复刻代码)

> 下表"借鉴的功能/设计"均指**重新实现该能力**,不搬运原项目代码。

| 参考 | 借鉴的功能/设计(重新实现) | 注意 / 要点 |
|---|---|---|
| **question-bank** | agent-engine 分层、SDK 集成方式、MySQL 当队列、沙箱、jsonl 回放、结构化输出、key 注入 | 单进程 EventEmitter→Redis;worker 并发 1→池;加会话归属校验;全局 key→每用户 key |
| **simple-agents** | deepagents 能力范式(多由 SDK 内置)、thread 级沙箱思路、webapp 副端点(models/reset/suggested) | 不用 LangGraph Platform;能力改由 claude-agent-sdk 提供 |
| **agent-chat-ui** | 独立应用架构、会话侧边栏、文件工作区、Artifact Portal、BFF 代理凭证 | 数据层换成自研 SSE;去 LangGraph 耦合(checkpoint 分支等 MVP 砍) |
| **langgraph-react-chatbot** | tool 四阶段流式状态机、custom 事件协议、joinStream 续流、命令式 ref API、工具名/图标映射、TodoList 面板 | apiKey/userId props→服务端 session 注入 |
| **open-webui** | 通用 AccessControl、Folder=项目容器、Model 编辑器=助手构建器、Valves、MCP=tool server transport、命令面板、SSE 事件语义 | 砍重型:pipelines/functions 三型、评测体系、频道/笔记/日历、30 搜索引擎、集中式 config.py |

---

## 11. 目录结构(初稿)

```
open-web-agents/
├─ src/
│  ├─ app/
│  │  ├─ (workbench)/            # 人用工作台:项目/会话/对话
│  │  ├─ (builder)/             # 助手构建器
│  │  ├─ (admin)/               # 管理后台:用户/权限/监控
│  │  └─ api/
│  │     ├─ assistants/ sessions/
│  │     ├─ sessions/[id]/run|files|events/
│  │     ├─ agents/[assistantId]/invoke/
│  │     └─ agents/[taskId]/result|events/
│  ├─ lib/
│  │  ├─ agent-engine/          # 通用引擎(core: spec/runner/events/result/config/artifacts)
│  │  ├─ assistant/             # 助手配置 → AgentSpec(buildSpec)
│  │  ├─ session-service/       # 会话/运行/队列/worker/事件总线(Redis)
│  │  ├─ db/                    # Drizzle schema + 迁移
│  │  ├─ auth/                  # NextAuth + API Key
│  │  └─ storage/               # 本地/OSS + 工作空间 GC
│  ├─ features/                 # 前端特性(chat 渲染内核、文件面板、builder 表单)
│  └─ components/               # shadcn/ui + ai-bot 渲染组件
├─ docs/
└─ package.json
```

---

## 12. MVP 范围与分期

**MVP(第一期)——把"造助手 → 跑会话 → 统一接口拿结构化结果"闭环打通:**

- 登录 + 每用户自带 base_url/key(三级覆盖:invoke > 会话 > 用户默认)
- 助手构建器(prompt/skills/mcp/tools/model + inputSchema/outputSchema,**schema 先写 JSON**)
- 会话管理 + 每会话独立工作目录(会话 = 项目 = 工作目录,一对一)
- Claude app 式多轮对话(流式 + 工具过程可视化 + 中断 + joinStream)
- 工作空间文件树 + 文件预览
- 统一运行接口 + 对外 `invoke`/`result`/`events`(结构化输出)
- API Key 鉴权
- Redis 事件总线 + MySQL 队列 + worker(从一开始就按可扩容做)

**第二期及以后(先不做):**

- 可嵌入 widget 打包、webhook 回调完善
- 通用 AccessControl UI、用户组、Valves UI
- MCP/Skills 管理界面、监控看板(用量/成本)
- 分支重跑、HITL 审批、容器级沙箱、多 agent 并行卡板
- 知识库/RAG、语音、图像生成、办公文件处理

---

## 13. 关键技术决策与风险

1. **多轮实现 = query()+resume**(非 streaming input):简单可靠,代价是运行中不能插话(可接受)。
2. **事件总线必须一开始就用 Redis**:question-bank 的单进程 EventEmitter 是多用户下的静默失效红线。
3. **沙箱平台差异**:macOS≥26 的 seatbelt 会吞 stdout,本地开发需 `SANDBOX=0`;生产 Linux/bubblewrap 正常。k8s 需允许 user namespaces。
4. **outputSchema 是接口契约的核心**:决定助手能否被系统消费,构建器里必须让用户能定义并预览。
5. **key 与产物安全**:脱敏 + 沙箱 denyRead + 会话归属校验,三者缺一不可。
6. **工作空间磁盘增长**:需两层 GC(完成清中间产物 + 保留期后清整目录)。

---

## 14. 待定问题(留给 review)

1. **助手构建器**里 inputSchema/outputSchema 的编辑形态:表单可视化搭 schema,还是直接写 JSON Schema / zod?
2. **通用助手**是否也允许无 schema 直接对外 invoke(只回文本),还是对外接口强制要求 outputSchema?
3. **项目 Project** 是否 MVP 就要,还是先只有"助手 + 会话"两层?
4. **模型/网关**:是否沿用 question-bank 的 `ANTHROPIC_BASE_URL` 兼容网关(挂 GLM 等)+ 别名槽?
5. **部署目标**:自托管单机 Docker 优先,还是一开始就考虑 k8s 水平扩容?
```
