# Open Web Agents 设计文档

## 1. 项目定位

Open Web Agents 是一个基于 `@anthropic-ai/claude-agent-sdk` 的多智能体平台。
用户可以配置专用智能体,然后通过两种入口使用同一个运行内核:

1. Web 工作台中的流式对话
2. 后端 API 的异步任务调用

项目目标不是只返回聊天文本,而是把 agent 能力收敛成可配置、可授权、可监控、可集成的业务智能体。

---

## 2. 当前功能

### 2.1 智能体管理

- 创建、更新智能体
- 配置 `systemPrompt`、`skills`、`mcpServers`、`tools`、`subagents`
- 配置模型别名、努力级别、最大轮次、权限模式、审批规则
- 可选配置 `inputSchema`、`outputSchema`、`verifyRules`、`webhookUrl`

### 2.2 Web 工作台

- 创建会话
- 通过 SSE 流式发起运行
- 断线后通过 `/events` 重新挂流
- 展示工具调用、思考过程、状态、文件产物、审批条
- 浏览工作空间文件树、预览和下载文件
- 对历史运行做分支和重跑

### 2.3 系统调用

- `POST /api/agents/{agentId}/invoke`
- `GET /api/agents/{taskId}/result`
- API Key 鉴权
- 每次 invoke 独立创建会话和工作目录
- 智能体定义 `outputSchema` 时返回结构化结果

### 2.4 多用户与权限

- 注册、登录、登出
- 首个注册用户自动成为 admin
- 智能体分享给用户、用户组或公开
- 用户组与成员管理
- API Key 签发与删除
- 会话、智能体、调用接口均做显式授权校验

### 2.5 运行安全与运维

- 每会话独立 `workspaceDir`
- agent 共享 `HOME=.agent-home`
- 路径围栏与可选 OS 沙箱
- 人工审批与超时自动拒绝
- MySQL 租约队列 + Redis 事件总线
- 健康检查、用量统计、工作空间 GC

### 2.6 嵌入能力

- 服务端生成 embed token
- 浏览器端通过 embed token 发起运行
- 平台提供嵌入脚本

---

## 3. 核心设计

### 3.1 同一个运行内核,两种消费方式

项目核心设计是 Web 对话与系统调用共用同一套运行编排。

两条入口分别是:

1. `POST /api/sessions/{id}/run`
   - Web 优先入口
   - 支持 `stream: true` 的 SSE
   - 也支持 `stream: false` 的阻塞 JSON

2. `POST /api/agents/{id}/invoke`
   - 系统调用入口
   - 创建新会话、新任务,异步返回 `taskId`
   - 通过 `result` 轮询终态

两者最终都汇聚到 `RunOrchestrator.execute()`。

### 3.2 智能体是否可集成,由 `outputSchema` 决定

系统里只有一种智能体实体 `agent`。
是否适合作为程序接口使用,由它是否定义 `outputSchema` 决定:

- 无 `outputSchema`:主要消费对话文本
- 有 `outputSchema`:运行结束后额外产出结构化结果

### 3.3 依赖隔离

当前代码对这些依赖做了明确隔离:

- Claude SDK
- MySQL
- Redis
- 文件存储
- 模型网关
- 权限与审批

最硬的一条边界是:
全工程只有 `src/lib/modules/agent-engine/adapters/claude-sdk/default-engine.ts` 直接 import Claude SDK。

---

## 4. 领域模型

### 4.1 用户与鉴权

1. `User`
   - 平台用户
   - 有 `role`
   - 可保存 `defaultBaseUrl` 与加密后的 `anthropicKeyEnc`

2. `ApiKey`
   - 系统调用凭证
   - 只存哈希,明文只在创建时返回一次
   - 归属用户,可选关联智能体

3. `Group`
   - 用户组
   - 用于授权批量分享

4. `AccessGrant`
   - 通用授权记录
   - 用一张表覆盖不同资源

### 4.2 智能体与知识

1. `Agent`
   - 平台一等公民
   - `config` 是完整的智能体定义
   - `inputSchema` 与 `outputSchema` 决定接口契约

2. `KnowledgeDoc`
   - 智能体级知识文档
   - 运行时按输入检索片段并注入提示词

### 4.3 会话、运行与产物

1. `Session`
   - 多轮上下文容器
   - 对应一个独立 `workspaceDir`
   - 保存会话级凭证覆盖和最新 `sdkSessionId`

2. `Run`
   - 一次具体执行
   - 进入队列,被 worker 认领
   - 记录 `resumeAnchor` 和本轮产出的 `sdkSessionId`
   - 支持分支来源 `parentRunId`

3. `Artifact`
   - 工作空间内生成的文件产物

---

## 5. 数据模型

当前核心表如下:

| 表 | 作用 | 关键字段 |
|---|---|---|
| `users` | 平台用户 | `email`, `role`, `default_base_url`, `anthropic_key_enc` |
| `agents` | 智能体定义 | `config`, `input_schema`, `output_schema`, `verify_rules`, `webhook_url` |
| `sessions` | 会话与工作目录 | `agent_id`, `workspace_dir`, `sdk_session_id`, `base_url`, `key_enc`, `model` |
| `messages` | 会话消息存档 | `session_id`, `role`, `content` |
| `runs` | 运行队列与终态 | `status`, `prompt`, `resume_anchor`, `sdk_session_id`, `lease_until`, `lease_owner` |
| `artifacts` | 产物文件元数据 | `session_id`, `path`, `mime`, `size`, `storage_url` |
| `api_keys` | 系统调用鉴权 | `owner_id`, `agent_id`, `hashed_key`, `quota` |
| `access_grants` | 通用授权 | `resource_type`, `resource_id`, `principal_type`, `principal_id`, `permission` |
| `knowledge_docs` | 智能体级知识库 | `agent_id`, `title`, `content` |
| `groups` | 用户组 | `name`, `owner_id` |
| `group_members` | 用户组成员 | `group_id`, `user_id` |
| `user_valves` | 每用户工具配置 | `user_id`, `tool_id`, `config` |

### 5.1 关键约束

1. `sessions` 保存会话最新锚点,用于普通多轮续跑
2. `runs` 逐轮保存 `resumeAnchor` 与 `sdkSessionId`,用于分支重跑和审计
3. `workspaceDir` 是 session 级字段,同一会话多轮共享一个工作目录
4. `knowledge_docs` 当前存原文,检索时再做切块与匹配

---

## 6. 模块划分

核心模块位于 `src/lib/modules/`:

| 模块 | 职责 |
|---|---|
| `access` | 资源授权、会话访问和 invoke 权限判定 |
| `agent-engine` | Claude SDK 适配、消息归一、沙箱和工具守卫 |
| `approval` | 人工审批请求、裁决与超时 |
| `artifacts` | 工作空间文件树、读取、预览、GC |
| `agent` | 智能体配置、构建 spec、输入输出校验 |
| `events` | 事件总线与重放缓冲 |
| `identity` | 用户、登录、API Key、密钥加解密 |
| `integration` | webhook 等外部集成 |
| `knowledge` | 智能体级知识文档和检索 |
| `model-gateway` | 模型别名槽到真实 modelId 的映射 |
| `run` | 运行编排、队列、worker、分支锚点 |
| `session` | 会话实体、工作目录路径规则 |
| `usage` | 用量聚合与成本视图 |

### 6.1 前端特性层

当前 UI 侧主要在 `src/features/`:

- `workbench`: 主工作台,包含对话区、审批条、文件面板
- `builder`: 智能体构建器、知识库、分享面板
- `chat`: SSE 拆帧与聊天视图
- `embed`: 嵌入式聊天
- `settings`: 凭证与 API Key 管理
- `groups`: 用户组管理
- `usage`: 用量页
- `auth`: 登录表单

---

## 7. 运行时设计

当前运行时由四部分组成:

1. Next.js Web 进程
   - 提供页面和 API route
   - 可内嵌 worker

2. Worker
   - 认领 run
   - 调用 orchestrator 执行
   - 可独立水平扩容

3. MySQL
   - 业务数据存储
   - 同时承担任务队列状态存储

4. Redis
   - 事件发布订阅
   - 审批状态协调

### 7.1 工作目录与 Claude 配置目录

当前路径规则:

- `workspaceDir = dataDir/workspaces/<sessionId>`
- agent 子进程 `HOME = dataDir/.agent-home`
- `CLAUDE_CONFIG_DIR = dataDir/.agent-home/.claude`

这样做的结果是:

1. 工作产物落在 session 工作目录
2. Claude transcript 与缓存落在共享 `.agent-home`
3. transcript 读写必须使用同一套路径推导规则

---

## 8. 关键运行链路

### 8.1 Web 对话: `/api/sessions/{id}/run`

当前 `/run` 路由支持两种模式:

1. `stream: true`
   - 默认模式
   - 返回 `text/event-stream`
   - 先订阅事件总线,后入队

2. `stream: false`
   - 等运行完成后聚合成单个 JSON 返回
   - 适合程序调用或调试

实际执行发生在 worker 中,HTTP 请求只负责提交任务和接收事件。

### 8.2 Orchestrator 执行顺序

`RunOrchestrator.execute()` 当前负责:

1. 读取 session 和 agent
2. 解析用户级、会话级、请求级凭证覆盖
3. 解析模型别名
4. 解析本轮起跑的 `resumeAnchor`
5. 检索知识库上下文
6. `buildSpec()` 组装 `AgentSpec`
7. 发布 `status` 事件
8. 调 `engine.run()` 执行 Claude SDK 会话
9. 记录新的 `sdkSessionId`
10. 若定义 `outputSchema`,对结构化结果做最终校验
11. 发布 `result` 事件
12. 触发 webhook 等终态回调

### 8.3 Claude SDK 执行层

`ClaudeSdkEngine.run()` 当前负责:

1. 调用 `queryFn`
2. 接收 SDK 流式消息
3. 从 `system:init` 提取 `session_id`
4. 识别 `stream_event`
5. 将 SDK 消息翻译为域内 `AgentEvent`
6. 避免“增量文本”和“完整 assistant 文本”重复发到前端
7. 尽量保住已拿到的终态结果

### 8.4 分支与重跑

`runs` 表里的 `parentRunId`、`resumeAnchor`、`sdkSessionId` 共同支持:

- 从某轮继续
- 从某轮重新分支
- 审计本轮实际从哪儿起跑

---

## 9. 事件模型

当前统一事件类型 `AgentEvent` 包括:

- `text`
- `thinking`
- `tool_use`
- `tool_result`
- `question`
- `status`
- `artifact`
- `usage`
- `result`

### 9.1 关键事件设计

1. `question`
   - 对应 SDK 的 `AskUserQuestion`
   - 前端渲染成可选按钮
   - 用户回答作为下一轮消息发出

2. `result.runId`
   - 区分同会话并发运行的终态归属

3. `usage`
   - 可能重复上报
   - 前端按 `messageId` 去重后累计

4. state 类事件
   - 当前包括 `status`、`artifact`、`usage`、`result`、`question`
   - 用于断线重连时回放

### 9.2 前端渲染策略

1. 连续 `text` 合并成一段
2. 连续 `thinking` 合并成一段
3. `tool_use` 与 `tool_result` 按 `toolUseId` 配对
4. `usage` 在汇总区显示,不打断正文

---

## 10. 队列、事件与重连

### 10.1 MySQL 队列

`runs` 表承担任务状态机:

- `pending`
- `running`
- `success`
- `failed`
- `cancelled`

通过这些字段实现可靠认领:

- `leaseUntil`
- `leaseOwner`
- `attempts`

`leaseOwner` 的作用是防止失去租约的旧 worker 覆写新 worker 结果。

### 10.2 Redis 事件总线

Redis 当前用于:

1. 运行过程事件广播
2. SSE 实时订阅
3. 审批协调

当前不是持久事件存储,因此配合 replay 缓冲使用。

### 10.3 joinStream

`GET /api/sessions/{id}/events` 的职责是把正在跑的会话重新接上:

1. 建立订阅
2. 等订阅生效
3. 读取 replay 缓冲
4. 补发快照之间到达的实时事件
5. 再持续跟随后续事件

---

## 11. API 设计

### 11.1 Web 入口

| 路径 | 说明 |
|---|---|
| `POST /api/auth` | 登录 / 注册 / 登出 |
| `GET /api/auth` | 当前登录态 |
| `GET/POST /api/sessions` | 列表 / 创建会话 |
| `POST /api/sessions/{id}/run` | 发起一轮运行 |
| `GET /api/sessions/{id}/events` | joinStream 重连 |
| `GET /api/sessions/{id}/files` | 文件树 / 预览 / 下载 |
| `GET/POST /api/sessions/{id}/approvals` | 待审批 / 批准拒绝 |
| `GET/POST /api/sessions/{id}/branch` | 分支与重跑 |
| `POST /api/sessions/{id}/cancel` | 取消运行 |

### 11.2 智能体与管理入口

| 路径 | 说明 |
|---|---|
| `GET/POST /api/agents` | 智能体列表 / 创建更新 |
| `GET/POST/DELETE /api/agents/{id}/share` | 分享管理 |
| `GET/POST/DELETE /api/agents/{id}/knowledge` | 智能体知识库 |
| `GET/POST /api/groups` | 用户组 |
| `POST /api/groups/{id}/members` | 组成员管理 |
| `GET/POST/DELETE /api/keys` | API Key 管理 |
| `PUT /api/me/credentials` | 用户自带凭证 |
| `GET /api/usage` | 用量视图 |

### 11.3 系统集成入口

| 路径 | 说明 |
|---|---|
| `POST /api/agents/{id}/invoke` | 对外触发智能体运行 |
| `GET /api/agents/{id}/result` | 查询任务结果 |
| `POST /api/embed/token` | 生成 embed token |
| `POST /api/embed/run` | 嵌入会话运行 |
| `GET /api/embed/script` | 嵌入脚本 |

### 11.4 健康检查

| 路径 | 说明 |
|---|---|
| `GET /api/health?probe=live` | 存活探针 |
| `GET /api/health` | 就绪探针 |

---

## 12. 权限与凭证链

### 12.1 三类鉴权

1. Web 登录态
   - cookie 鉴权
   - 供 Web 工作台使用

2. API Key
   - 第三方系统调用
   - 不等价于 Web 登录态

3. Embed token
   - 嵌入式前端调用
   - 权限边界小于 API Key

### 12.2 凭证优先级

agent 实际使用的凭证解析顺序为:

`request > session > user > platform`

其中:

- `baseUrl` 独立解析
- `key` 独立解析
- `model` 独立解析

---

## 13. 安全设计

### 13.1 当前防护

1. 路径围栏
   - 限制 agent 文件写入路径

2. 共享 HOME 分离
   - agent 的 `HOME` 定向到 `.agent-home`

3. 密钥加密与脱敏
   - 用户 key 加密入库
   - 事件流和日志边界做脱敏

4. 审批
   - 可对工具名、命令模式或全部工具启用人工审批

5. 授权显式校验
   - 路由层不信任前端传参

### 13.2 当前边界

1. `OWA_SANDBOX=0` 时不具备 OS 沙箱
2. 开启 `OWA_ALLOW_STDIO_MCP=1` 后,智能体可在宿主机启动进程
3. 共享 `.agent-home` 带来缓存复用,也提高宿主级污染风险
4. 事件总线不是持久队列,依赖 replay 与数据库终态兜底

---

## 14. 前端交互约束

1. 前端用 `fetch + getReader()` 读取 SSE
2. 对话区除最终文本外,还要展示 thinking、tool、status、approval、artifact
3. 打字机效果依赖后端 `stream_event` 与前端连续增量合并
4. `question` 事件必须渲染成可回答的交互元素

---

## 15. 运维约束

1. worker 可独立进程运行,也可嵌在 web 进程里
2. 部署时必须验证任务真实跑通,不能只看进程存活
3. 滚动更新时要给 worker 足够的优雅退出时间
4. 工作空间和 transcript 会持续占用磁盘,需要 GC
5. 生产环境缺少 `OWA_SESSION_SECRET` 或 `OWA_SECRET_KEY` 会拒绝启动
