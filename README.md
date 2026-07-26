# Open Web Agents

基于 [claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) 的智能体平台:
可视化地定义**特定场景的专用助手**,每个助手对外提供一套统一接口 —— 既能网页对话使用,
也能被企业系统当接口调用,拿到**结构化结果**与**全程过程监控**。

与通用智能体(Claude app / Codex / LobeHub)的区别:它们产出对话文本,没法直接喂给应用系统。
这里的助手可以定义 `outputSchema`,于是「跑一次」就变成「调一个接口拿一段 JSON」。

```
企业后端 ──invoke──▶ 助手 ──▶ { "verdict": "pass", "issues": [...], "score": 88 }
                      │
网页工作台 ────────────┘   同一个运行内核,只是入口与结果投递不同
```

---

## 快速开始

前置:Node 22+、pnpm、MySQL 8、Redis 7。

```bash
pnpm install
cp .env.example .env.local        # 填 OWA_ANTHROPIC_API_KEY 等
pnpm db:migrate                   # 建表
pnpm dev                          # http://localhost:3000
```

首次打开会引导注册 —— **第一个注册的用户自动成为 admin**,自托管无需额外的初始化脚本。

### 一分钟体验闭环

1. `/builder` 建一个助手,填提示词;想让它能被系统调用就再填 `outputSchema`
2. `/` 工作台里跟它对话,右侧看它在独立工作目录里生成的文件
3. `/settings` 签发 API Key,然后:

```bash
curl -X POST localhost:3000/api/agents/<助手id>/invoke \
  -H "X-Api-Key: <key>" -H 'Content-Type: application/json' \
  -d '{"input":"……"}'
# → { "taskId": "..." }
curl localhost:3000/api/agents/<taskId>/result -H "X-Api-Key: <key>"
# → { "status": "success", "structured": { ... } }
```

---

## 能力一览

| 能力 | 说明 |
|---|---|
| 助手构建器 | 提示词 / 模型 / 轮次 / Skills / MCP / 子代理 / 工具白名单 / inputSchema / outputSchema / 审批规则 / Webhook |
| 统一运行接口 | 网页对话与系统 invoke **共用同一个运行内核** |
| 结构化输出 | 定义了 `outputSchema` 才算「接口型助手」;结果经 JSON Schema 校验,不合格判失败 |
| 入参契约 | 定义了 `inputSchema` 则 `invoke` 的入参必须符合它,否则 400 并指出是哪个字段 |
| 工作空间 | 每会话一个独立目录,文件树 / 预览 / 下载 |
| 执行隔离 | OS 内核沙箱(Bash)+ 路径守卫(文件工具),见下文限制 |
| 人工审批(HITL) | 按工具名或命令模式挂起等人确认,超时自动拒绝 |
| 知识库 | 助手级文档,运行时按问题检索片段注入提示词(BM25) |
| 权限 | 登录 / 每用户凭证 / API Key / 助手分享 / 用户组 |
| 可嵌入 widget | 一行 `<script>` 挂到企业页面;**API Key 不下发浏览器** |
| 用量监控 | 按助手 / 按天的花费与 token,队列积压提示 |
| 队列与扩容 | MySQL 租约队列 + Redis 事件总线 + 可独立扩容的 worker |

---

## 架构

务实的六边形(Ports & Adapters):**只对真正会变的依赖建端口**,其余不过度抽象。

```
app/            页面与 API route(薄:HTTP ↔ 用例)
lib/container   composition root —— 全工程唯一决定「用哪个实现」的地方
lib/modules/
  agent-engine  唯一封装 SDK 的模块(ACL:SDK 消息 → 域内 AgentEvent)
  run           编排 / 状态机 / 队列 / worker
  assistant     助手配置 / buildSpec / 输出校验
  model-gateway 模型别名槽 → 真实 modelId(可挂任意兼容网关)
  session       会话与工作空间
  access        授权判定 / 用户组
  identity      登录 / 凭证加密 / API Key
  knowledge     检索
  approval      人工审批
  events        事件总线 / 断线重放
  artifacts     文件与 GC
  integration   对外集成 / 嵌入令牌
  usage         用量聚合
```

**依赖铁律**:`domain/**` 零框架依赖、零 IO,可 100% 单测。
全工程**只有 `agent-engine/adapters/claude-sdk/default-engine.ts` 一个文件 import SDK** ——
SDK 升级只需改归一层,业务零改动;归一层由录制回放测试守护。

### 换实现只改 container

```ts
// 内存 → MySQL / Redis,只改这一处,上层无感
const runs = new MysqlRunRepo(db);      // 曾是 InMemoryRunRepo
const bus  = new RedisBus(env.redisUrl); // 曾是 InMemoryBus
```

端口都有**契约测试**:内存实现与真实实现跑同一套断言,保证可替换性不是口号。

---

## 配置

全部环境变量以 `OWA_` 前缀。完整列表见 `.env.example`,以下是要点:

| 变量 | 说明 |
|---|---|
| `OWA_DATABASE_URL` | MySQL 连接串 |
| `OWA_REDIS_URL` | Redis 连接串 |
| `OWA_DATA_DIR` | 会话工作空间根目录(**会被解析成绝对路径**) |
| `OWA_ANTHROPIC_BASE_URL` / `_API_KEY` | 平台默认凭证(三级链兜底) |
| `OWA_MODEL` 与 `OWA_MODEL_{OPUS,SONNET,HAIKU,FABLE}` | 别名槽 → 真实 modelId |
| `OWA_SESSION_SECRET` | 登录会话签名。**生产未设置会拒绝启动** |
| `OWA_SECRET_KEY` | 用户凭证加密主密钥。**生产未设置会拒绝启动** |
| `OWA_AUTH_REQUIRED` | 是否要求登录,默认 1;仅本地开发可设 0 |
| `OWA_SANDBOX` | OS 内核沙箱,默认 1;**macOS 本地开发需设 0**,见限制 |
| `OWA_EMBEDDED_WORKER` | 设 0 关掉 web 进程内嵌的 worker(拆进程部署时用) |
| `OWA_SHUTDOWN_GRACE_MS` | worker 收到 SIGTERM 后等在途任务的上限,默认 60000 |

### 凭证三级覆盖

`请求级 override > 会话级 > 用户自带 > 平台默认`,`baseUrl` 与 `key` 各自独立回退 ——
允许用户只覆盖 key 而沿用平台网关。用户自带的 key 用 AES-256-GCM 加密入库,
只在运行时解密注入 agent 子进程;界面只回掩码。

> `OWA_SECRET_KEY` 泄露 = 所有用户的 key 泄露。它是可逆加密(要原样取回注入子进程),不是哈希。

---

## 部署

```bash
export OWA_SESSION_SECRET=$(openssl rand -base64 32)
export OWA_SECRET_KEY=$(openssl rand -base64 32)
export OWA_ANTHROPIC_API_KEY=...
docker compose up -d
docker compose up -d --scale worker=4   # worker 无本地状态,可直接扩
```

拓扑:`web`(收请求、发 SSE)+ `worker`(跑 agent)+ MySQL + Redis。
web 与 worker **用同一个镜像**,只是启动命令不同。迁移由 `migrate` 服务单独跑一次 ——
让每个实例各自迁移会在多实例下打架。

不用容器也行:

```bash
# 方式一:直接跑
OWA_EMBEDDED_WORKER=0 pnpm start    # web
pnpm worker:prod                     # worker(可起多个)

# 方式二:用 standalone 产物(约 49MB,容器镜像用的就是它)
cd .next/standalone && OWA_EMBEDDED_WORKER=0 node server.js
```

worker 进程会自己加载 `.env` / `.env.local`(与 web 同一套配置)。
这一步曾经缺失,后果不是起不来而是**起得来但什么都干不成**:进程健康、日志正常,
而每个任务都以 `no key resolved from credential chain` 失败。
教训写在这儿:验证部署方式时,**要让它真的跑完一个任务**,不能只看进程活着。

### 滚动更新

worker 收到 SIGTERM 后先停止认领新任务,再**等在途任务真正落终态**
(上限 `OWA_SHUTDOWN_GRACE_MS`,默认 60 秒)。超时才强退,那些任务由租约过期后的
孤儿回收接手 —— 栅栏令牌保证它们不会被重复写入结果。

编排系统的 `terminationGracePeriodSeconds` 要**大于**这个值,否则进程会被 SIGKILL
打断,白等一场。

### 健康检查

- `GET /api/health?probe=live` — 存活探针,**不碰任何依赖**。
  数据库挂了不等于进程该死;重启修不好数据库,反而会把正在跑的任务全打断。
- `GET /api/health` — 就绪探针,探 MySQL 与 Redis,未就绪返回 503 供编排摘流量。

---

## API 速查

鉴权分三种,严格分开:**登录 cookie**(网页)、**`X-Api-Key`**(第三方系统)、
**`X-Embed-Token`**(浏览器 widget,权限被限死在单个会话)。

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/auth` | — | 登录 / 注册 / 登出 |
| GET | `/api/auth` | cookie | 当前登录态(key 只回掩码) |
| PUT | `/api/me/credentials` | cookie | 设置自带 base_url / key |
| GET/POST | `/api/assistants` | cookie | 列出可见助手 / 创建更新 |
| GET/POST/DELETE | `/api/assistants/{id}/share` | cookie(write) | 分享给用户 / 组 / 公开 |
| GET/POST/DELETE | `/api/assistants/{id}/knowledge` | cookie(读 read、写 write) | 知识文档 |
| GET/POST | `/api/groups` · `/api/groups/{id}/members` | cookie | 用户组与成员 |
| GET/POST/DELETE | `/api/keys` | cookie | API Key(明文仅签发时返回一次) |
| GET/POST | `/api/sessions` | cookie / key | 会话列表与创建 |
| POST | `/api/sessions/{id}/run` | cookie / key | 发起一轮,SSE 流式返回 |
| GET | `/api/sessions/{id}/events` | cookie / key | joinStream 断线重连 |
| GET | `/api/sessions/{id}/files` | cookie / key | 文件树 / 预览 / 下载 |
| GET/POST | `/api/sessions/{id}/approvals` | cookie / key | 待审列表 / 批准拒绝 |
| GET/POST | `/api/sessions/{id}/branch` | cookie / key | 运行列表 / 重跑 |
| POST | `/api/sessions/{id}/cancel` | cookie / key | 取消未完成的运行(见下方延迟说明) |
| POST | `/api/agents/{id}/invoke` | **key** | 对外触发,返回 taskId |
| GET | `/api/agents/{id}/result` | **key** | 轮询结构化结果 |
| POST | `/api/embed/token` | **key** | 换短时效嵌入令牌(服务端调) |
| POST | `/api/embed/run` | **embed token** | widget 发起运行 |
| GET | `/api/embed/script` | — | 嵌入脚本 |
| GET | `/api/usage` | cookie | 用量与成本 |
| GET | `/api/health` | — | 就绪 / 存活探针 |

SSE 传输是裸 `data: <AgentEvent JSON>\n\n`。前端用 `fetch + getReader` 手工拆帧,
不能用原生 `EventSource` —— 后者带不了鉴权头。

---

## 已知限制

这些是实测撞出来的,不是猜测。

### macOS 本地开发必须关沙箱

macOS 的 seatbelt 沙箱会**吞掉沙箱内 Bash 的 stdout** —— agent 跑什么命令都拿不到输出。
本地开发设 `OWA_SANDBOX=0`;生产 Linux 用 bubblewrap,沙箱正常。

**沙箱关闭时 Bash 没有围栏。** 文件工具(Write/Edit/Read)由路径守卫拦住,始终生效;
但 Bash 执行任意命令,路径藏在命令文本里,引号/变量/拼接都能绕过匹配 ——
只能靠内核沙箱。所以本地开发环境下不要跑不受信任的助手。

### SDK 的 session id 不是时间点快照

同一会话连跑两轮,SDK 返回的 `session_id` **完全相同**,resume 它得到的是最新状态。
所以「回到第 2 轮之前换个说法重做」做不到 —— 那样实现出来会是个看起来像分支、
实际仍在主线继续的假功能。因此只提供两种语义真实的重跑:

- `fresh` — 不 resume,干净上下文重来(跑歪了换个说法再试的正解)
- `continue` — resume 当前状态,等价追加一轮

### 兼容网关对结构化输出的支持不一致

第三方 Anthropic 兼容网关(DashScope / GLM 等)对 `output_format` 的支持并不稳定,
实测同一助手时而拿不到 `structured_output`。平台留了降级路径:从最终文本里提取 JSON,
**提取结果仍要过 outputSchema 校验**,并打 `salvagedFromText` 标记便于运维识别。

### 两处「写了但没跑过」

仓库里其余每一条声明都有实测支撑,只有这两处没有 —— 单独列出来,免得它们混在
一堆已验证的内容里被默认为也验过了。

**容器化配置**:`Dockerfile` 与 `docker-compose.yml` 只做了结构校验,
**镜像构建与容器编排从未实际执行**(开发机上没有 Docker)。首次部署请预留调试时间。

**CI 工作流**:`.github/workflows/ci.yml` **从未在 GitHub Actions 上真正跑过**
(本地没有远端仓库)。

已经验证的是每一条 `run:` 里的命令本身能跑通 —— `pnpm ci:dryrun` 会按 ci.yml 的
步骤顺序在本机实跑一遍(建库、迁移两个库、typecheck、lint、645 单测、
**故意抽掉依赖确认跳过守卫真的会拦下**、build、e2e 53 条、服务被拆干净)。
这个脚本在仓库里,谁都可以复现,不是一句"我验过了"。

预跑过程中它挡下了两个本会让 CI 失灵的问题:
- `mysql` 命令行:GitHub 的 ubuntu 运行器默认不带,改用 mysql2(本来就是依赖)
- `pnpm test | tee` 少了 `pipefail`:GitHub 默认 bash 只有 `-e`,
  **测试失败会被 tee 的成功退出码盖住,CI 照样绿**

**没有验证的是 Actions 特有的那部分**:服务容器健康检查时序、容器网络连通性、
`pnpm/action-setup` 与 `packageManager` 的配合、缓存命中。
这些只有真推一次才知道 —— 首次 CI 变红大概率出在这几处,而不是业务代码。

### 检索是关键词而非语义

知识库用 BM25,不是向量检索。术语命中型查询(手册 / SOP / FAQ)效果好;
「换个说法问同一件事」这类语义查询会漏。检索接口与实现解耦,将来换向量检索不动上层。

相关性下限是**相对**的(不低于本次最高分的 25%),不是固定阈值 —— 固定阈值会随语料
规模漂移,实测 50 篇文档时命中直接归零,也就是「知识库越完善越检索不到」。
中文分词过滤了虚词单字,否则一个「的」就能让任意两段中文匹配上。

### 取消有最多 15 秒延迟

`POST /cancel` 把运行标记为 cancelled,正在执行的那个 worker 要到下一次心跳
(默认 15 秒)才发现自己已被取消并中止。接口的响应里如实写了这一点 ——
界面不应在点下去的瞬间就宣称「已停止」。

**已知不一致**:取消时 SSE 末帧报 `status:"failed"`(摘要是 `aborted by user`),
而数据库里是 `cancelled`。因为 result 事件由编排层发布,它区分不了这次中止来自
取消还是故障;worker 知道但手上没有总线。数据库口径是准确的。

---

## 开发

```bash
pnpm test          # 单元 + 契约 + 并发 + 故障注入(约 3 秒)
pnpm test:e2e      # 端到端:自动构建、起服务、跑攻击面、拆干净(约 1 分钟)
pnpm typecheck
pnpm lint          # Biome
pnpm build
pnpm ci:dryrun     # 按 ci.yml 的步骤在本机实跑一遍(需 OWA_CI_DB_URL)
```

`pnpm test:e2e` 默认用 3100 端口,不会碰你正在跑的 3000。
想打到一个已经起好的服务上:`OWA_E2E_BASE_URL=http://... pnpm test:e2e:run`。

### CI

`.github/workflows/ci.yml` 每次 push / PR 跑两个 job,都起真实的 MySQL 与 Redis
服务容器:

| job | 内容 |
|---|---|
| `check` | 迁移 → typecheck → lint → 单元/契约/并发/故障注入 |
| `e2e` | 迁移 → build → 起服务 → 攻击面断言 → 拆干净 |

**为什么不用 mock 跑 CI**:队列的乐观锁认领、租约栅栏、Redis 订阅时序、跨进程审批,
全都只在真依赖上才暴露。用 mock 换来的绿灯,恰恰是当初漏掉那些缺陷的原因。

CI 里有一条容易被忽略但很关键的守卫:**需要真实依赖的测试如果被跳过,直接判失败**。
这些套件在依赖缺失时会跳过,而 `pnpm test` 仍然是绿的 —— 那种绿最危险,
看起来通过了,其实队列、总线、审批一条都没验。CI 的全部价值建立在
「绿灯是真的」这个前提上,所以这里必须硬失败。

集成测试需要真实依赖,**且必须指向专用测试库**:

```bash
export OWA_TEST_DATABASE_URL=mysql://root:pw@127.0.0.1:3306/owa_test  # 库名须含 test
export OWA_TEST_REDIS_URL=redis://127.0.0.1:6379
```

> 库名的 `test` 不是约定而是**强制**:契约测试会清表,曾经把它指向开发库直接删了数据。
> 现在 `_truncate` 要求调用方传库名自证,指错会抛错而不是默默删掉。

未设置这两个变量时,相关测试会跳过并打印说明 —— 不会静默假过。

### 测试分层

| 层 | 覆盖 |
|---|---|
| 域逻辑 | 纯函数穷举:状态机、凭证解析、归一 ACL、检索评分、授权判定、路径安全 |
| 端口契约 | 一套断言跑两遍:内存实现与真实 MySQL / Redis |
| 并发 | 多 worker 抢同一队列,断言每个任务恰好执行一次、且**并发真的发生了** |
| 故障注入 | 每个可选依赖依次打挂,验证降级而非崩溃 |
| 端到端 | 对真正跑着的服务从 HTTP 打进去:越权攻击面、归属隔离、路径穿越、取消、健康探针 |

**为什么端到端这一层不能省。** 最严重的那几个缺陷(任意用户能跑他人私有助手、
API Key 可被全平台枚举吊销)的共同点是:每一层单独看都合理,合起来才出事 ——
授权体系写得好好的,只是**运行路径没接上它**。域层单测覆盖得了判定表,
覆盖不了"路由到底有没有调它"。

这套 e2e 做过变异验证,确认它不是摆设:把 `sessions` 路由里的授权调用注释掉
(域逻辑完好,正是当初漏洞的真实形态)——

```
pnpm test        → 645 passed        ← 全绿,毫无察觉
pnpm test:e2e    → 2 failed          ← 恰好是描述该漏洞的那两条
```

测试文件**串行执行**(`fileParallelism: false`)。契约测试与并发测试打同一个测试库,
而队列语义是全局的(`claimNext` 取全表最旧、`_truncate` 清整张表),文件级并行下
A 的清表会删掉 B 刚入队的任务。这曾经表现为「偶发失败」,加到第三个 DB 测试文件后
变成必现,根因才浮出来。全套约 3 秒,串行换来的确定性远比这点墙钟时间值钱。

### 数据库变更

```bash
pnpm db:generate   # 改完 src/lib/db/schema.ts 后生成迁移
pnpm db:migrate
```

---

## 设计文档

- `docs/superpowers/specs/2026-07-26-open-web-agents-design.md` — 需求与产品蓝图
- `docs/superpowers/specs/2026-07-26-open-web-agents-architecture.md` — 分层、模块、端口、设计模式
