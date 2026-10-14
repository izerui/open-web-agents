# Open Web Agents

基于 [claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) 的智能体平台:
可视化地定义**特定场景的专用智能体**,每个智能体对外提供一套统一接口 —— 既能网页对话使用,
也能被企业系统当接口调用,拿到**结构化结果**与**全程过程监控**。

与通用智能体(Claude app / Codex / LobeHub)的区别:它们产出对话文本,没法直接喂给应用系统。
这里的智能体可以定义 `outputSchema`,于是「跑一次」就变成「调一个接口拿一段 JSON」。

```
企业后端 ──invoke──▶ 智能体 ──▶ { "verdict": "pass", "issues": [...], "score": 88 }
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
pnpm dev                          # http://localhost:5678
```

首次打开会引导注册 —— **第一个注册的用户自动成为 admin**,自托管无需额外的初始化脚本。

### 一分钟体验闭环

1. `/builder` 建一个智能体,填提示词;想让它能被系统调用就再填 `outputSchema`
2. `/` 工作台里跟它对话,右侧看它在独立工作目录里生成的文件
3. 「设置 → 接入中心」(`/settings/keys`)签发 API Key,并按智能体复制 curl / Python / Node / 嵌入代码;或者直接:

```bash
curl -X POST localhost:5678/api/agents/<智能体id>/invoke \
  -H "X-Api-Key: <key>" -H 'Content-Type: application/json' \
  -d '{"input":"……"}'
# → { "taskId": "..." }
curl localhost:5678/api/agents/<taskId>/result -H "X-Api-Key: <key>"
# → { "taskId": "...", "status": "success", "done": true, "structured": { ... }, ... }
```

---

## 能力一览

| 能力         | 说明                                                                                       |
|------------|------------------------------------------------------------------------------------------|
| 智能体构建器      | 提示词 / 模型 / 轮次 / 技能包 / MCP / 子代理 / 工具白名单 / inputSchema / outputSchema / 审批规则 / Webhook |
| **AI 智能体设计师** | 用对话设计智能体:设计师在会话工作目录里编辑智能体包(提示词、技能、MCP、契约),用户点「应用」后经正式校验写入,一键试运行,不满意继续对话迭代 |
| 技能包         | 智能体自带的 Skill(SKILL.md + 脚本/模板),运行时作为平台只读插件加载,agent 自己改不了 |
| 统一运行接口     | 网页对话与系统 invoke **共用同一个运行内核**                                                             |
| 结构化输出      | 定义了 `outputSchema` 才算「接口型智能体」;结果经 JSON Schema 校验,不合格判失败                                   |
| 入参契约       | 定义了 `inputSchema` 则 `invoke` 的入参必须符合它,否则 400 并指出是哪个字段                                    |
| 工作空间       | 每会话一个独立目录,文件树 / 预览 / 下载                                                                  |
| 执行隔离       | OS 内核沙箱(Bash)+ 路径守卫(文件工具),见下文限制                                                          |
| 人工审批(HITL) | 按工具名或命令模式挂起等人确认,超时自动拒绝;审批服务不可用时按故障拒绝并如实标注,不记为超时。三档裁决:批准一次 / 批准并授权本会话内同类不再询问(可撤销;一条命令命中多个高风险模式时,须每一类都已授权才自动放行)/ 拒绝(可附说明,作为原因交给智能体)。接口调用、嵌入组件没有审批人,按智能体配置直接放行或拒绝 |
| 会话管理       | 重命名 / 归档 / 删除;签发 Key 的人能在"接口调用"视图里看到自己 Key 发起的会话                           |
| 账号安全       | 注册开关、登录限流、管理员建号与重置密码、自助改密码                                                    |
| 知识库        | 智能体级文档,运行时按问题检索片段注入提示词(BM25)                                                              |
| 权限         | 登录 / 每用户凭证 / API Key / 智能体分享 / 用户组                                                        |
| 可嵌入 widget | 一行 `<script>` 挂到企业页面;**API Key 不下发浏览器**                                                  |
| 用量监控       | 按智能体 / 按天的花费与 token,队列积压提示                                                                |
| 队列与扩容      | MySQL 租约队列 + Redis 事件总线 + 可独立扩容的 worker;运行**至多执行一次**                               |
| 结果回调       | 终态 webhook 走数据库发件箱,失败按退避重试;按所有者的密钥做 HMAC 签名                                      |
| 幂等调用       | `invoke` 支持 `Idempotency-Key`,超时重试拿回同一个任务,不重复执行与计费                                  |

---

## AI 智能体设计师

在「我的智能体」里点 **用 AI 设计**(新建)或 **用 AI 修改**(已有智能体),会开一个与内置
"AI 智能体设计师"的对话。设计师不直接改平台配置,而是编辑会话工作目录里的**智能体包**:

```
agent/agent.json               名称、描述、模型、轮次、MCP、子代理、审批、输入输出契约、开场建议
agent/system-prompt.md         系统提示词
agent/skills/<名称>/SKILL.md    技能(frontmatter 的 description 写"何时使用")
agent/skills/<名称>/...         技能附带的脚本、模板
```

工作台上方的 **应用到智能体** 会解析这些文件,走与构建器保存完全相同的校验后创建或更新智能体;
校验不通过时可一键把问题发回给设计师修复。回调地址、逃生舱、归属不在包里,应用时沿用原值。
应用后点 **试运行** 打开新智能体,把不满意的地方告诉设计师继续改。

技能在运行时写入 `dataDir/.skills/<内容哈希>/` 作为本地插件交给 SDK —— 不放开 `settingSources`,
agent 也写不进这个目录(沙箱只放开工作目录,文件写工具受路径守卫限制)。

## 版本与发布

智能体分**草稿**与**已发布版本**。构建器保存、AI 设计师「应用」改的都是草稿;
在构建器下方的「版本与发布」里把草稿发布为 v1、v2……

| 入口 | 跑哪一版 |
|---|---|
| 接口调用 `invoke` | 当前发布的版本;请求体可用 `"version": N` 锁定某一版 |
| 嵌入组件、API Key 建的会话 | 当前发布的版本 |
| 网页工作台 | 能修改该智能体的人(作者)跟随草稿,便于试运行;其他人用已发布版本 |
| 从未发布过的智能体 | 一律草稿(与发布功能上线前的行为相同) |

- 版本在**建会话时锁定**,同一会话的每一轮都用同一版;发布或回滚只影响之后新建的会话。
- **回滚**是把发布指针指回旧版本,不新建版本;**载入草稿**把旧版本内容放回草稿继续改。
- 入参校验、结构化结果、OpenAPI 文档都以实际使用的版本为准;结果接口、运行记录与 webhook 带 `agentVersion`(`null` = 草稿)。
- 回调地址不属于版本内容;切换到逃生舱不同的版本只有平台管理员能做。

## 审计日志

「设置 → 审计日志」记录谁在什么时候对什么做了什么:智能体的创建 / 修改(只记改了哪些字段,
不记内容)/ 发布 / 回滚 / 载入草稿、分享、知识文档、API Key 的签发 / 吊销 / 限额、审批裁决、
账号管理、登录与登录失败、个人凭证与签名密钥的变更、用户组。

- **谁看得到**:资源归属人与操作者本人;管理员可看全平台。别人改了你分享出去的智能体、
  有人试图登录你的账号,你都看得到。
- **机密不进日志**:Key 明文、密码、签名密钥、模型 Key、提示词内容一律不记;审批只记
  工具名与裁决,不记工具调用原文(Bash 命令里可能带令牌)和审批备注;登录失败只在账号存在时记邮箱
  (防止误输进邮箱框的密码落库);另有按字段名的兜底打码。用户自己起的名称与说明
  (智能体名、Key 名、版本说明、文档标题)按原样记录,请勿在其中填写机密。
- **有界**:每次记录(查操作者快照 + 写入)总等待上限 1 秒,超时按尽力记录处理、请求照常返回;
  超时只是不再等,底层写入并未取消,之后仍可能落库。
- **已知取舍**:审计在业务操作成功之后单独写入,写失败只记错误日志、不回滚业务。
  两次写入之间进程崩溃或审计写失败,这条审计会丢;需要强保证时应改为同库同事务的发件箱。

## 架构

务实的六边形(Ports & Adapters):**只对真正会变的依赖建端口**,其余不过度抽象。

```
app/            页面与 API route(薄:HTTP ↔ 用例)
lib/container   composition root —— 全工程唯一决定「用哪个实现」的地方
lib/modules/
  agent-engine  唯一封装 SDK 的模块(ACL:SDK 消息 → 域内 AgentEvent)
  run           编排 / 状态机 / 队列 / worker
  agent         智能体配置 / buildSpec / 输出校验
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
const bus = new RedisBus(env.redisUrl); // 曾是 InMemoryBus
```

端口都有**契约测试**:内存实现与真实实现跑同一套断言,保证可替换性不是口号。

---

## 配置

全部环境变量以 `OWA_` 前缀。完整列表见 `.env.example`,以下是要点:

| 变量                                                  | 说明                                         |
|-----------------------------------------------------|--------------------------------------------|
| `OWA_DATABASE_URL`                                  | MySQL 连接串                                  |
| `OWA_REDIS_URL`                                     | Redis 连接串                                  |
| `OWA_DATA_DIR`                                      | 会话工作空间根目录(**会被解析成绝对路径**)                   |
| `OWA_ANTHROPIC_BASE_URL` / `_API_KEY`               | 平台默认凭证(三级链兜底)                              |
| `OWA_MODEL` 与 `OWA_MODEL_{OPUS,SONNET,HAIKU,FABLE}` | 别名槽 → 真实 modelId                           |
| `OWA_SESSION_SECRET`                                | 登录会话签名。**生产未设置会拒绝启动**                      |
| `OWA_SECRET_KEY`                                    | 用户凭证加密主密钥。**生产未设置会拒绝启动**                   |
| `OWA_AUTH_REQUIRED`                                 | 是否要求登录,默认 1;仅本地开发可设 0                      |
| `OWA_SANDBOX`                                       | OS 内核沙箱,默认 1;**macOS 本地开发需设 0**,见限制        |
| `OWA_ALLOW_STDIO_MCP`                               | 是否允许 stdio MCP,默认 0;开启后智能体可在宿主机启动程序,仅可信部署使用 |
| `OWA_EMBEDDED_WORKER`                               | 设 0 关掉 web 进程内嵌的 worker(拆进程部署时用)           |
| `OWA_SHUTDOWN_GRACE_MS`                             | worker 收到 SIGTERM 后等在途任务的上限,默认 60000       |
| `OWA_WORKER_CONCURRENCY`                            | 单个 worker 进程同时执行的运行数,默认 4(同一会话仍串行)     |
| `OWA_WEBHOOK_ALLOW_PRIVATE`                         | webhook 允许投递到内网私有网段,默认 0;回环与云元数据地址始终禁止 |
| `OWA_ALLOW_SIGNUP`                                  | 是否开放自助注册,默认 1;第一个账号始终可注册并成为管理员       |
| `OWA_AUTH_IP_RATE_LIMIT`                            | 同一地址每 15 分钟的登录/注册上限,默认 30,0 关闭;按账号限流始终开启 |

### 凭证三级覆盖

`请求级 override > 用户自带 > 平台默认`。允许只覆盖 key 而沿用上一层的网关(见下方同层绑定)。用户自带的 key 用 AES-256-GCM 加密入库,
只在运行时解密注入 agent 子进程;界面只回掩码。

请求级 override(`invoke` 的 `override` 字段)整体加密后随任务入队,只在 worker 执行时解密;
解不开就让这一轮失败,不会悄悄回落到平台凭证。

**同层绑定**:`baseUrl` 取最高优先的那一层,`key` 必须来自同一层或更高优先的层。
只覆盖 key、沿用平台网关是允许的;**自定义了 baseUrl 却不给 key,会被拒绝** ——
否则平台 key 会被发往调用方指定的地址。

**逃生舱(`escapeHatch`)** 只有平台管理员能设置;沙箱、hooks、cwd、env、权限模式等
安全边界字段不能通过它覆盖(保存时拒绝,运行时也强制以平台为准)。

**计费账号**:每个会话有一个计费账号(`sessions.billing_user_id`)—— 网页会话是它的所有者,
API Key / embed 会话是签发那把 key 的账号。花费记在它头上、额度按它算、"用户自带"这一层
凭证也取它的。额度在入口查一次,worker 执行前再复核一次(两者之间隔着队列)。
额度是**事前检查**而非预留:并发中的运行可能让实际花费略超上限,超出量以并发运行数为界。

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
(上限 `OWA_SHUTDOWN_GRACE_MS`,默认 60 秒)。到点仍在跑的运行会被主动中止、落 `failed`。

**运行是至多一次的**:worker 崩溃或失租时,租约过期后的孤儿回收把运行判为 `failed`
(`error.kind = "worker_lost"`),**不会**交给别的 worker 从头重跑。原因是运行有外部副作用
(MCP 调用、Bash 里的网络请求),栅栏令牌只挡得住重复写结果,挡不住重复执行。
需要重试的调用方自行重新 `invoke`(配合 `Idempotency-Key` 防止重复受理)。

编排系统的 `terminationGracePeriodSeconds` 要**大于**这个值,否则进程会被 SIGKILL
打断,白等一场。

### 工作目录回收

每个进程每 30 分钟触发一次回收;Redis 锁让同一时刻只有一个进程去扫(只为省掉重复扫描)。

- 会话结束 1 小时后清中间产物(`node_modules`、`.venv`、日志、临时文件),业务产出保留。
- 最后活动超过 7 天整体删除工作目录。会话与对话历史不删;工作台提示"工作目录已自动清理",
  继续对话时在原路径重建空目录。
- **与新运行、上传的并发**:写工作目录的一方(运行启动、文件上传)动手前先锁住会话行,记下
  "刚用过"并确保目录存在;GC 动手时锁住同一行,在锁内重新判定(保留期内无活动、没有刚用过的
  记录、没有在执行的运行),成立才在锁内把目标改名挪进 `workspaces/.trash`,放锁后再删除。
  两边在同一把行锁上串行,不存在"判定之后、动手之前"的窗口;正确性不依赖 Redis 锁。
  清理标记在【确实挪走之后】于同一事务里记下;源目录已不在(另一个 GC 已挪走)视为未执行,
  不记标记,不会覆盖先到那一批的清理时刻。
- **文件操作不随事务回滚**:改名挪走之后若事务提交失败(或进程在两步之间退出),只有数据库
  标记回滚,文件已在回收站里。回收站批次因此【先核对再删】,且核对也在该会话的行锁里做
  (正在提交的批次会等它结束):库里的清理时刻与批次一致才删;否则挪回原处;原处已有新目录
  则留存到 `workspaces/.orphaned` 并报错,需人工处理,GC 永不自动删除它。

### 健康检查

- `GET /api/health?probe=live` — 存活探针,**不碰任何依赖**。
  数据库挂了不等于进程该死;重启修不好数据库,反而会把正在跑的任务全打断。
- `GET /api/health` — 就绪探针,探 MySQL 与 Redis,未就绪返回 503 供编排摘流量。

---

## API 速查

鉴权分三种,严格分开:**登录 cookie**(网页)、**`X-Api-Key`**(第三方系统)、
**`X-Embed-Token`**(浏览器 widget,权限被限死在单个会话)。

| 方法              | 路径                                         | 鉴权                     | 说明                  |
|-----------------|--------------------------------------------|------------------------|---------------------|
| POST            | `/api/auth`                                | —                      | 登录 / 注册 / 登出        |
| GET             | `/api/auth`                                | cookie                 | 当前登录态(key 只回掩码)     |
| PUT             | `/api/me/credentials`                      | cookie                 | 设置自带 base_url / key |
| POST/DELETE     | `/api/me/webhook-secret`                   | cookie                 | 设置或生成 / 清除 webhook 签名密钥 |
| PUT             | `/api/me/password`                         | cookie                 | 修改自己的登录密码          |
| PATCH/DELETE    | `/api/sessions/{id}`                       | cookie / key           | 重命名、归档 / 删除会话      |
| GET             | `/api/sessions?view=integrations`          | cookie                 | 用自己 Key 发起的接口调用会话 |
| POST            | `/api/embed/cancel`                        | **embed token**        | 停止嵌入会话里的运行         |
| POST/PATCH      | `/api/admin/accounts`                      | cookie(admin)          | 建号、改角色/停用/额度、重置密码 |
| GET/POST        | `/api/agents`                              | cookie                 | 列出可见智能体 / 创建更新       |
| DELETE          | `/api/agents/{id}`                         | cookie(所有者 / 管理员) | 软删除:调用、嵌入、分享、绑定的 Key 随之失效;历史会话与运行记录保留,id 不可复用;内置智能体不可删 |
| GET/POST/DELETE | `/api/agents/{id}/share`                   | cookie(write)          | 分享给用户 / 组 / 公开      |
| GET/POST/DELETE | `/api/agents/{id}/knowledge`               | cookie(读 read、写 write) | 知识文档                |
| GET/POST        | `/api/groups` · `/api/groups/{id}/members` | cookie                 | 用户组与成员              |
| GET/POST/DELETE/PATCH | `/api/keys`                          | cookie                 | API Key(明文仅签发时返回一次);PATCH 调整每分钟调用上限 |
| GET/POST        | `/api/sessions`                            | cookie / key           | 会话列表与创建             |
| POST            | `/api/sessions/{id}/run`                   | cookie / key           | 发起一轮,SSE 流式返回;用 Key 建的会话里,声明了 inputSchema 的智能体须传符合它的 `input` |
| GET             | `/api/sessions/{id}/events`                | cookie / key           | joinStream 断线重连     |
| GET             | `/api/sessions/{id}/files`                 | cookie / key           | 文件树 / 预览 / 下载       |
| GET/POST/DELETE | `/api/sessions/{id}/approvals`             | cookie / key           | 待审与同类授权列表 / 裁决(`remember:"session"` 授权同类,`message` 拒绝说明)/ 撤销同类授权(`?grant=`) |
| GET/POST        | `/api/sessions/{id}/branch`                | cookie / key           | 运行列表 / 重跑           |
| POST            | `/api/sessions/{id}/cancel`                | cookie / key           | 取消未完成的运行(见下方延迟说明)   |
| POST            | `/api/sessions/{id}/steer`                 | cookie / key           | 运行中途追加一条消息(见下方)     |
| POST            | `/api/agents/{id}/invoke`                  | **key**                | 对外触发,返回 taskId;支持 `Idempotency-Key`、单次 `callbackUrl` |
| GET             | `/api/agents/{id}/result`                  | **key**                | 轮询结构化结果             |
| GET             | `/api/agents/{id}/openapi.json`            | cookie / key           | 该智能体的 OpenAPI 3.1 文档(含入参与结果契约) |
| GET             | `/api/agents/{id}/webhook/deliveries`      | cookie(所有者)          | 回调投递记录              |
| POST            | `/api/agents/{id}/webhook/test`            | cookie(所有者)          | 测试投递                |
| POST            | `/api/runs/{id}/webhook/redeliver`         | cookie(所有者)          | 手动重发回调              |
| GET             | `/api/audit`                               | cookie                 | 审计日志(与自己相关的;管理员 `scope=all` 看全部) |
| GET/POST        | `/api/agents/{id}/versions`                | 读:cookie / key;发布:cookie(write) | 版本列表 / 把草稿发布为新版本 |
| GET             | `/api/agents/{id}/versions/{v}`            | cookie / key           | 某个版本的完整内容            |
| POST            | `/api/agents/{id}/versions/{v}/activate`   | cookie(write)          | 把发布指针切到该版本(回滚)    |
| POST            | `/api/agents/{id}/versions/{v}/restore`    | cookie(write)          | 把该版本载入草稿            |
| POST            | `/api/embed/token`                         | **key**                | 换短时效嵌入令牌(服务端调)      |
| POST            | `/api/embed/run`                           | **embed token**        | widget 发起运行         |
| GET             | `/api/embed/script`                        | —                      | 嵌入脚本                |
| GET             | `/api/usage`                               | cookie                 | 用量与成本               |
| GET             | `/api/health`                              | —                      | 就绪 / 存活探针           |

SSE 传输是裸 `data: <AgentEvent JSON>\n\n`。前端用 `fetch + getReader` 手工拆帧,
不能用原生 `EventSource` —— 后者带不了鉴权头。

终态 `result` 事件在运行**落库之后**才发布,与数据库口径一致。事件总线是尽力而为的:
那条事件若丢失,SSE 与 `stream:false` 阻塞请求会从数据库读到终态收尾,不会一直挂着。

输入(`prompt` / `invoke` 的 `input`)上限 200,000 字符,超出返回 413。

### 运行中途追加消息

工作台与 API 会话的运行在进行中也能继续补充:`POST /api/sessions/{id}/steer`,`{ runId, text, id }`。
`id` 是这条消息的稳定标识(8~64 个字母、数字、`-`、`_`),**重试时必须复用** —— 同一 id 只入队一次;
不传则由服务端生成,此时无法安全重试。
模型还在干活(之后还会调工具)时,这条会插进当前这一轮;已经在写最终回答时,会在这一轮回答之后
再答一轮 —— 这一次运行的结局、正文与结构化结果以最后一轮为准,美元取最终累计值,token 按轮累加。
接口调用(invoke)与嵌入组件是一次性输入,不接受追加。

答复如实反映结局,不会在没确认送达时说成功:

| 状态 | outcome / code | 含义 |
|---|---|---|
| 200 | `delivered` | 已交给模型 |
| 202 | `pending` | 已受理,等待上限(5 秒)内没等到结局;最终结局看事件流里的 `steer` 事件(`delivered` / `dropped`) |
| 202 | `unknown` | 受理请求本身没得到答复(超时 / 连接问题),这条**可能已经入队** —— 用同一个 `id` 再请求一次,不要改作新消息 |
| 409 | `not_accepting` | 这一轮还没开始或已经收尾,这条**没有受理** —— 可以作为新消息发送 |
| 409 | `dropped` | 受理了,但运行在交给模型前结束了 —— 可以作为新消息发送 |

可靠性约定:
- 受理与关闭输入检查同一个状态(Redis 里各一段 Lua):第一条结果到达时关闭输入,此前受理的仍会交给模型,
  此后到达的一律不受理。
- 读取只读不删,worker 记下结局(送达 / 未送达)时才删除 —— 读取的响应超时丢了,消息也还在,
  收尾时会重新读到并给出结局。
- 同一 `id` 的结论只定一次:没受理时也会留下记录,所以超时后才真正执行的同 `id` 受理不会再入队。
- 只有 `not_accepting` / `dropped` 是"可以重发"的定局。工作台据此自动改为本轮结束后发送;
  多次重试仍不确定时只提示"未确认",不自动重发。
- 需要 Redis 可用:Redis 持续不可用时,已受理消息的结局可能一直是 `pending`。

### 统一的运行结果

`GET /api/agents/{taskId}/result`、`stream:false` 阻塞响应、Webhook 的 `run.finished` 载荷
都由同一份数据库记录、经同一个函数组装,共有这些字段:

| 字段 | 说明 |
|---|---|
| `taskId` | 运行 id |
| `status` / `done` | `pending` / `running` / `success` / `failed` / `cancelled`;后三者 `done=true` |
| `agentVersion` | 本次运行用的已发布版本号;跑草稿时为 `null` |
| `structured` | 结构化结果(定义了 `outputSchema` 才有) |
| `salvaged` | `true` 表示结构化结果是从模型正文里补救解析出来的,而不是经结构化输出工具交付 |
| `text` | 最终正文 |
| `error` | `null` 或 `{ kind, message, status? }` |
| `cost` | `null` 或 `{ usd?, input, output, partial? }` |
| `startedAt` / `endedAt` | ISO 时间 |

另有各自的附加字段:`/result` 与 Webhook 保留旧字段 `summary`(同 `text`,已弃用);阻塞响应
带 `runId`、`thinking`、`toolCalls`、`usage`;Webhook 带 `deliveryId`、`event`、`sessionId`、`agentId`。

> **不兼容变更**:阻塞响应的 `error` 以前是字符串,现在与另两处一致,是 `{ kind, message }` 对象。

### 调用限流

用 API Key 发起的**新运行**都要限流 —— `invoke`、用 Key 建的会话里的 `/sessions/{id}/run` 与重跑、
嵌入组件(访客的运行记在签发令牌的 Key 上)。用同一个 `Idempotency-Key` 重放已受理的任务不计入。两层固定窗口:

- 每把 API Key 每分钟 `OWA_INVOKE_RATE_LIMIT_PER_KEY` 次(默认 60)。签发时或在接入中心可单独调低;只有管理员能调高。
- 每个智能体每分钟 `OWA_INVOKE_RATE_LIMIT_PER_AGENT` 次(默认 600,所有 Key 合计)。

超出返回 `429 rate_limited`,body 里 `scope` 为 `key` 或 `agent`,带 `Retry-After`;
`202` 响应带 `X-RateLimit-Limit / Remaining / Reset`,调用方可据此自我节流。
检查顺序:鉴权 → 幂等重放 → 限流 → 额度 → 版本与契约校验 → 入队。
Redis 不可用时限流放行(花费仍受月度额度约束)。固定窗口在窗口交界处最多可能放过两倍的突发。

### Webhook

智能体配了回调地址,运行落终态(成功 / 失败 / 取消 / worker 失联)后会 `POST` 一次:

```
X-OWA-Delivery:  <taskId>          # 重发时不变,接收方据此去重
X-OWA-Timestamp: <unix 秒>
X-OWA-Signature: v1=<hex(HMAC-SHA256(密钥, "<timestamp>.<原始请求体>"))>
```

- 签名密钥按用户设置(设置 → 模型凭证 → Webhook 签名密钥),该用户名下所有智能体共用;
  没配置则不带签名头。验签时用**原始请求体字节**,并拒绝时间戳过旧的请求以防重放。
- 投递是**至少一次**:失败按 30s / 2m / 10m / 30m / 2h 退避重试,4xx(408/429 除外)不重试。
- 只有智能体所有者(与管理员)能查看和修改回调地址;有 write 权限的协作者也不行 ——
  否则能把所有者名下全部调用的结果转发走。
- 地址不能指向回环、链路本地(含云元数据 169.254.169.254)等网段;内网私有网段需
  `OWA_WEBHOOK_ALLOW_PRIVATE=1`。保存时检查字面量;投递时的检查接在**建连自己的那次 DNS 解析**上,
  被检查的地址就是被连接的地址 —— 域名两次解析返回不同地址(DNS rebinding)绕不过去。
  请求仍以原始域名发出,Host 头与 TLS 证书校验照常针对域名;不复用连接,不跟随重定向。
- **单次调用指定回调地址**:`invoke` 请求体带 `callbackUrl`,这次的结果就投到它(代替智能体配置的地址,
  智能体没配回调也可以),用**调用方**(签发这把 Key 的账号)的签名密钥签名 —— 接收方是调用方自己;
  调用方没配密钥则不签名,不会借用所有者的密钥。地址规则同上,不合规直接 400。
  它也算请求内容:同一个 `Idempotency-Key` 换了地址按冲突处理(422)。
- 没指定 `callbackUrl` 的运行投到智能体**投递时**配置的地址,不在受理时快照 ——
  所有者修好配错的地址后点"重发",投的是修好的新地址。

**投递记录、测试与重发**(接入中心,仅智能体所有者与管理员):每次投递记一行(第几次、对方状态码、
错误、耗时、是否签名),回调地址只存协议 + 主机 + 路径(查询串常带令牌,不落库)。
"发送测试"向当前地址发 `event: "webhook.test"`,签名与正式回调相同,同步返回结果。
"重发"把某次运行的回调放回发件箱按正常流程发出,只对接口调用与 API 会话的运行开放,
还在投递中的不重复入队。记录写入尽力而为、有 2 秒等待上限:写不进去不影响投递结果与接口返回
(超时只是不再等,底层写入未取消)。

---

## 已知限制

这些是实测撞出来的,不是猜测。

### macOS 本地开发必须关沙箱

macOS 的 seatbelt 沙箱会**吞掉沙箱内 Bash 的 stdout** —— agent 跑什么命令都拿不到输出。
本地开发设 `OWA_SANDBOX=0`;生产 Linux 用 bubblewrap,沙箱正常。

**沙箱关闭时 Bash 没有围栏。** 文件工具(Write/Edit/Read)由路径守卫拦住,始终生效;
但 Bash 执行任意命令,路径藏在命令文本里,引号/变量/拼接都能绕过匹配 ——
只能靠内核沙箱。所以本地开发环境下不要跑不受信任的智能体。

### 会话之间没有读隔离

每个会话有独立工作目录,但**隔离的只是写入**。所有会话共享 `dataDir/.agent-home`
作为 HOME,SDK 把每个会话未脱敏的完整过程(transcript)写在其下的 `.claude/projects/`;
沙箱的禁读名单只覆盖宿主 HOME 的敏感目录,路径守卫也只拦写不拦读。所以任何会话的
Bash 或 Read 工具都能读到其它会话的 transcript。`OWA_SANDBOX=0` 时 Bash 更是没有任何围栏。

这是项目明确接受的边界(见 `agents.md` §13.2),适合单租户或内部部署。
对外多租户需按租户分离 SDK 状态,并对 Bash 和文件工具落实对应的文件访问边界。

### SDK 的 session id 不是时间点快照

同一会话连跑两轮,SDK 返回的 `session_id` **完全相同**,resume 它得到的是最新状态。
所以「回到第 2 轮之前换个说法重做」做不到 —— 那样实现出来会是个看起来像分支、
实际仍在主线继续的假功能。因此只提供两种语义真实的重跑:

- `fresh` — 不 resume,干净上下文重来(跑歪了换个说法再试的正解)
- `continue` — resume 当前状态,等价追加一轮

### 兼容网关对结构化输出的支持不一致

第三方 Anthropic 兼容网关(DashScope / GLM 等)对 `output_format` 的支持并不稳定,
实测同一智能体时而拿不到 `structured_output`。平台留了降级路径:从最终文本里提取 JSON,
**提取结果仍要过 outputSchema 校验**,并打 `salvagedFromText` 标记便于运维识别。

### 两处「写了但没跑过」

仓库里其余每一条声明都有实测支撑,只有这两处没有 —— 单独列出来,免得它们混在
一堆已验证的内容里被默认为也验过了。

**容器化配置**:`Dockerfile` 与 `docker-compose.yml` 只做了结构校验,
**镜像构建与容器编排从未实际执行**(开发机上没有 Docker)。首次部署请预留调试时间。

**CI 工作流**:`.github/workflows/ci.yml` **从未在 GitHub Actions 上真正跑过**
(本地没有远端仓库)。

已经验证的是每一条 `run:` 里的命令本身能跑通 —— `pnpm ci:dryrun` 会按 ci.yml 的
步骤顺序在本机实跑一遍(建库、迁移两个库、typecheck、lint、全部单测、
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

### 取消:通常立即生效,最坏 15 秒

`POST /cancel` 把运行标记为 cancelled 后,通过 Redis 通知正在执行它的 worker 立即中止。
通知是"尽力而为"的(pub/sub 最多一次):丢了的话,worker 在下一次续租心跳(默认 15 秒)
时也会发现并中止。被取消的运行已消耗的 token 照样入账(美元金额未知时只记 token)。

取消时 SSE 末帧是 `status:"cancelled"`,与数据库一致。(曾经报 `failed`:result 事件由编排层
在落库前发布,分不清中止来自取消还是故障。现在由真正写入终态的一方发布。)

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

`pnpm test:e2e` 默认用 3100 端口,不会碰你正在跑的 5678。
想打到一个已经起好的服务上:`OWA_E2E_BASE_URL=http://... pnpm test:e2e:run`。

### CI

`.github/workflows/ci.yml` 每次 push / PR 跑两个 job,都起真实的 MySQL 与 Redis
服务容器:

| job     | 内容                                    |
|---------|---------------------------------------|
| `check` | 迁移 → typecheck → lint → 单元/契约/并发/故障注入 |
| `e2e`   | 迁移 → build → 起服务 → 攻击面断言 → 拆干净        |

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

| 层    | 覆盖                                              |
|------|-------------------------------------------------|
| 域逻辑  | 纯函数穷举:状态机、凭证解析、归一 ACL、检索评分、授权判定、路径安全            |
| 端口契约 | 一套断言跑两遍:内存实现与真实 MySQL / Redis                   |
| 并发   | 多 worker 抢同一队列,断言每个任务恰好执行一次、且**并发真的发生了**        |
| 故障注入 | 每个可选依赖依次打挂,验证降级而非崩溃                             |
| 端到端  | 对真正跑着的服务从 HTTP 打进去:越权攻击面、归属隔离、路径穿越、取消、健康探针      |
| 架构边界 | 机械检查依赖铁律:domain 零框架依赖、模块间只经公开面、SDK 只在一个文件、装配点唯一 |

**为什么端到端这一层不能省。** 最严重的那几个缺陷(任意用户能跑他人私有智能体、
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
- `docs/superpowers/specs/2026-07-28-open-web-agents-current-design.md` — **按当前代码收敛后的详细设计基线**
- `docs/architecture-deviations.md` — **代码与文稿不一致的地方,以及每一处的理由**

两份 specs 是动工前写的,**原样保留、不回填修改** —— 它记录的是当时的判断,
改掉它就抹掉了「我们后来知道了什么」。偏离都记在第三份文件里。
