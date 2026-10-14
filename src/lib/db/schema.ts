// Drizzle schema — 对应设计文档 §5 数据模型的 9 张表。
// JSON 列承载灵活配置;金额/token 一律整数或字符串,不用 float。

import {
  bigint,
  index,
  int,
  json,
  mediumtext,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: varchar("id", { length: 36 }).primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  role: varchar("role", { length: 16 }).notNull().default("user"),
  defaultBaseUrl: varchar("default_base_url", { length: 512 }),
  /** 每用户自带的 Anthropic key,加密入库 */
  anthropicKeyEnc: varchar("anthropic_key_enc", { length: 1024 }),
  /**
   * 禁用的账号不能登录,已登录的会话也立即失效。
   * 【为什么用 int 而不是 boolean】drizzle 的 mysql boolean 底层就是 tinyint,
   * 用 int 少一层映射歧义;这张表也没有别的布尔列可循例。
   */
  disabled: int("disabled").notNull().default(0),
  /**
   * 月度花费上限(微美元)。null = 不限。
   * 【为什么是微美元】和 runs.costMicroUsd 同一单位,比较时不必换算,
   * 也避免浮点误差 —— 本文件开头就定了"金额一律整数"。
   */
  monthlyQuotaMicroUsd: bigint("monthly_quota_micro_usd", { mode: "number" }),
  /**
   * Webhook 签名密钥,加密入库(与 anthropicKeyEnc 同一把主密钥)。
   * 该用户名下所有智能体的回调都用它做 HMAC 签名;没配置则回调不带签名头。
   * 必须可逆:签名时要取回明文。
   */
  webhookSecretEnc: varchar("webhook_secret_enc", { length: 1024 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const agents = mysqlTable(
  "agents",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    ownerId: varchar("owner_id", { length: 36 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    icon: varchar("icon", { length: 64 }),
    description: varchar("description", { length: 1024 }),
    /** AgentConfig:systemPrompt/skills/mcpServers/tools/subagents/model/effort/maxTurns */
    config: json("config").notNull(),
    inputSchema: json("input_schema"),
    /** 定义了才能被企业系统当接口消费(设计文档 §3) */
    outputSchema: json("output_schema"),
    webhookUrl: varchar("webhook_url", { length: 1024 }),
    /**
     * 当前发布的版本号;NULL = 从未发布,所有入口都用草稿(本行的配置)。
     * 本行的 name/config/schema 始终是【草稿】—— 构建器与设计师只改草稿,
     * 对外入口(接口调用、嵌入、API 会话)跑的是这里指向的版本快照。
     */
    publishedVersion: int("published_version"),
    /** 已发布版本的内容摘要,用来判断"草稿有没有未发布的修改",免得每次都去读快照 */
    publishedHash: varchar("published_hash", { length: 64 }),
    /**
     * 软删除时刻(ms);非空即"已删除":列表、调用、嵌入、分享、继续对话都当它不存在。
     * 行保留 —— 历史会话、运行记录(按 JOIN 显示名称)、审计、版本都还要引用它。
     * id 也因此不能被新智能体复用。
     */
    deletedAt: bigint("deleted_at", { mode: "number" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({ byOwner: index("idx_agents_owner").on(t.ownerId) }),
);

/**
 * 智能体的发布版本:发布时把草稿整份快照下来,之后只读。
 * 版本号按智能体从 1 递增;回滚 = 把 agents.published_version 指回旧版本,不新建行。
 */
export const agentVersions = mysqlTable(
  "agent_versions",
  {
    agentId: varchar("agent_id", { length: 36 }).notNull(),
    version: int("version").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    icon: varchar("icon", { length: 64 }),
    description: varchar("description", { length: 1024 }),
    /** 完整 AgentConfig(含 inputSchema / outputSchema) */
    config: json("config").notNull(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    note: varchar("note", { length: 512 }),
    createdBy: varchar("created_by", { length: 36 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({ pk: uniqueIndex("uniq_agent_versions").on(t.agentId, t.version) }),
);

/** 会话 = 项目 = 工作目录,一对一。 */
export const sessions = mysqlTable(
  "sessions",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    agentId: varchar("agent_id", { length: 36 }).notNull(),
    /** 人用时归属用户 */
    ownerId: varchar("owner_id", { length: 36 }),
    /** 系统 invoke 时归属调用方 key */
    callerApiKeyId: varchar("caller_api_key_id", { length: 36 }),
    /**
     * 计费归属账号:花费记给谁、额度按谁算、用谁自带的模型凭证。
     *
     * 【为什么不复用 ownerId】ownerId 决定"谁能在工作台里看到并操作这个会话";
     * API Key 与 embed 建的会话没有人用归属,但花费必须落到签发 key 的账号上。
     * 曾经额度统计按 ownerId 聚合,于是这两类入口的花费不计入任何人的额度。
     */
    billingUserId: varchar("billing_user_id", { length: 36 }),
    workspaceDir: varchar("workspace_dir", { length: 512 }).notNull(),
    /** 上一轮 SDK session id,多轮 resume 用 */
    sdkSessionId: varchar("sdk_session_id", { length: 128 }),
    title: varchar("title", { length: 255 }),
    /**
     * 无人值守会话(接口 invoke)。
     *
     * 【为什么不能用 callerApiKeyId 代替】embed 会话也是 API Key 建的,
     * 但浏览器前坐着真人 —— 拿它当判据会把嵌入式对话误判成无人值守。
     * 这个字段只表达一件事:出事时有没有人能回答。
     */
    unattended: int("unattended").notNull().default(0),
    /**
     * 会话从哪个入口来:web(工作台)/ api(API Key 建的会话)/ invoke(接口调用)/ embed(嵌入组件)。
     * 决定审批怎么走(有没有人能批)、结果是否推 webhook、在哪个列表里展示、用量怎么拆分。
     * 曾经只能靠 unattended / callerApiKeyId / title 拼凑判断,embed 与 API 会话分不开。
     */
    source: varchar("source", { length: 16 }).notNull().default("web"),
    /**
     * 设计会话要修改的目标智能体(由"AI 智能体设计师"驱动的会话才有)。
     * 存在库里而不是工作目录里:工作目录是设计师自己能写的,目标不能被它改指向。
     * 新建智能体的设计会话一开始为空,第一次"应用"后填上。
     */
    designTargetAgentId: varchar("design_target_agent_id", { length: 36 }),
    /**
     * 会话锁定的智能体版本;NULL = 跟随草稿。
     * 建会话时定下来,整个会话的每一轮都用同一版本 —— 多轮对话中途换版本,
     * 前后轮的提示词与契约对不上。
     */
    agentVersion: int("agent_version"),
    /**
     * 工作目录被 GC 整体清理的时刻(ms);NULL = 没被清过。
     * 会话本身(对话历史)还在,只是之前生成的文件没了 —— 界面据此提示用户;
     * 再次运行会在同一路径重建空目录继续。
     */
    workspacePurgedAt: bigint("workspace_purged_at", { mode: "number" }),
    /**
     * 最近一次"有人要写工作目录"的时刻(ms):运行启动、文件上传。
     * 在会话行锁内写入;GC 在同一把锁里看到它比保留期新,就不动这个目录。
     * 上传文件不产生运行 —— 没有它,GC 只看运行时间,刚上传的文件可能马上被清掉。
     */
    workspaceTouchedAt: bigint("workspace_touched_at", { mode: "number" }),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    byAgent: index("idx_sessions_agent").on(t.agentId),
    byOwner: index("idx_sessions_owner").on(t.ownerId),
    byBilling: index("idx_sessions_billing").on(t.billingUserId),
    byCaller: index("idx_sessions_caller").on(t.callerApiKeyId),
  }),
);

/**
 * 运行队列。MySQL 当队列:乐观锁认领 + 租约续期 + 孤儿回收,零中间件。
 * (status, lease_until) 联合索引支撑认领查询。
 */
export const runs = mysqlTable(
  "runs",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    sessionId: varchar("session_id", { length: 36 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    /**
     * 本轮输入。入口按 MAX_PROMPT_CHARS 限长(见 run/domain/limits.ts)。
     * 曾经是 varchar(8192) 且入口不校验:结构化 input 稍大一点,INSERT 就在严格模式下
     * 报错 500,而会话与工作目录此时已经建好了。
     */
    prompt: mediumtext("prompt").notNull(),
    /**
     * 入队时的智能体配置快照。worker 按它执行,而不是执行时去读"当前配置" ——
     * 排队期间配置被改,不该改变已经受理的任务;事后也能追溯结果出自哪一版配置。
     * 迁移前入队的旧任务为空,回退到当前配置。
     */
    agentConfig: json("agent_config"),
    /** 执行的智能体版本;NULL = 草稿。结果、运行记录、回调里都带上,便于追溯。 */
    agentVersion: int("agent_version"),
    /** 请求级凭证覆盖(三级链最高优先),整体加密的 JSON。只在 worker 执行时解密。 */
    overrideEnc: varchar("override_enc", { length: 2048 }),
    /**
     * 幂等键(调用方作用域 + 调用方给的键)。同一键重复提交返回同一个任务,
     * 网络超时重试不会产生重复执行与重复计费。
     */
    idempotencyKey: varchar("idempotency_key", { length: 191 }),
    /** 首次受理时请求体的摘要。同键不同请求体 → 422,而不是悄悄返回另一个任务。 */
    idempotencyHash: varchar("idempotency_hash", { length: 64 }),
    /** 分支来源:从哪个运行分叉而来。为空即主线首轮。 */
    parentRunId: varchar("parent_run_id", { length: 36 }),
    /**
     * 这一轮开始时 resume 的 SDK 会话。
     * 必须逐轮记录 —— 只存会话的最新锚点就回不到中间某轮,分支重跑无从谈起。
     */
    resumeAnchor: varchar("resume_anchor", { length: 128 }),
    /** 这一轮跑完产生的 SDK 会话,供后续轮次/分支续接。 */
    sdkSessionId: varchar("sdk_session_id", { length: 128 }),
    /**
     * 这一轮自己产生的第一条 / 最后一条消息的 uuid(SDK transcript 里的行)。
     * 续接同一个 SDK 会话的各轮写进【同一份】jsonl,历史回放按它截出本轮那一段;
     * 曾经每轮都读整份文件,于是第 1 轮也显示出之后各轮的过程。为空 = 旧数据,读整份。
     */
    transcriptFirstUuid: varchar("transcript_first_uuid", { length: 64 }),
    transcriptLastUuid: varchar("transcript_last_uuid", { length: 64 }),
    /** 租约到期时间戳(ms)。NULL = 未认领或已完成 */
    leaseUntil: bigint("lease_until", { mode: "number" }),
    /**
     * 栅栏令牌:本次认领的唯一标识,每次认领重新生成。
     *
     * 光有租约时间不够 —— 失去租约的 worker 并不知道自己失去了,它照样能写库。
     * 后续所有写入(续租/落结果/落终态)都要带上认领时拿到的令牌,对不上就是空操作:
     * 让「僵尸 worker 覆写接手者的结果」从小概率事件变成做不到。
     */
    leaseOwner: varchar("lease_owner", { length: 36 }),
    /** 被认领的次数,用于识别反复崩溃的任务 */
    attempts: int("attempts").notNull().default(0),
    structuredResult: json("structured_result"),
    /** 结构化结果是从最终文本里提取的(非原生 structured_output)。对外结果的 salvaged 字段 */
    structuredSalvaged: int("structured_salvaged"),
    /**
     * 本轮最终 Assistant 文本的查询投影;完整过程仍以 SDK jsonl 为准。
     * MEDIUMTEXT:TEXT 只有 64KB,长回答写不进去会让一次成功的运行在落库时失败。
     */
    finalText: mediumtext("final_text"),
    cost: json("cost"),
    errorInfo: json("error_info"),
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
    /**
     * 终态回调的发件箱状态:pending / delivering / delivered / failed / skipped。
     * 落终态的同一条 UPDATE 里置为 pending,投递器按它补发 ——
     * 曾经是进程内 fire-and-forget,进程一挂回调就永久丢失。
     */
    webhookState: varchar("webhook_state", { length: 16 }),
    /**
     * 受理时定下的回调目标快照。之后改智能体的回调地址,不会把已受理的任务(含自动重试、手动重发)转投到新地址。
     * callback_source 同时说明地址来源,决定用谁的密钥签名:
     *   agent  = 智能体当时配置的默认地址,所有者签名
     *   caller = 调用方在 invoke 时指定的 callbackUrl,调用方(签发 Key 的账号)签名
     *   none   = 受理时没有回调,不投
     *   NULL   = 快照功能之前受理的旧任务,按投递时的配置投
     * 地址只能和来源一起看:同一个地址字段若不带来源,共享智能体的默认回调会被签错密钥。
     */
    callbackUrl: varchar("callback_url", { length: 1024 }),
    callbackSource: varchar("callback_source", { length: 8 }),
    webhookAttempts: int("webhook_attempts").notNull().default(0),
    /**
     * 本次投递认领的令牌(每次认领新生成)。投递结果的写回必须带上它、且状态仍是 delivering:
     * 租约过期被别人接手、或被手动重发清掉之后,旧投递的结果写不回来 ——
     * 否则卡住的旧投递返回成功时会把"已受理的重发"覆盖成 delivered,重发就不会再执行。
     * (不用 attempts 判断身份:手动重发会把它清零。)
     */
    webhookLease: varchar("webhook_lease", { length: 36 }),
    /** 下一次可投递的时刻(ms);投递中时兼作租约到期时刻。 */
    webhookNextAt: bigint("webhook_next_at", { mode: "number" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    byClaim: index("idx_runs_claim").on(t.status, t.leaseUntil),
    bySession: index("idx_runs_session").on(t.sessionId),
    byParent: index("idx_runs_parent").on(t.parentRunId),
    byWebhook: index("idx_runs_webhook").on(t.webhookState, t.webhookNextAt),
    // 运行记录与用量按时间倒序查;没有它每次都是全表排序
    byCreated: index("idx_runs_created").on(t.createdAt),
    uniqIdempotency: uniqueIndex("uniq_runs_idempotency").on(t.idempotencyKey),
  }),
);

export const apiKeys = mysqlTable(
  "api_keys",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    agentId: varchar("agent_id", { length: 36 }),
    ownerId: varchar("owner_id", { length: 36 }).notNull(),
    /** 只存哈希,明文只在创建时返回一次 */
    hashedKey: varchar("hashed_key", { length: 128 }).notNull().unique(),
    name: varchar("name", { length: 255 }),
    /** 这把 Key 每分钟的新调用上限;NULL = 用平台默认(OWA_INVOKE_RATE_LIMIT_PER_KEY) */
    rateLimitPerMinute: int("rate_limit_per_minute"),
    lastUsedAt: timestamp("last_used_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({ byOwner: index("idx_api_keys_owner").on(t.ownerId) }),
);

/** 通用授权:一张表覆盖 agents/sessions 等资源;principalId="*" 表示 public。 */
export const accessGrants = mysqlTable(
  "access_grants",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    resourceType: varchar("resource_type", { length: 32 }).notNull(),
    resourceId: varchar("resource_id", { length: 36 }).notNull(),
    principalType: varchar("principal_type", { length: 16 }).notNull(),
    principalId: varchar("principal_id", { length: 36 }).notNull(),
    permission: varchar("permission", { length: 16 }).notNull(),
  },
  (t) => ({ byResource: index("idx_grants_resource").on(t.resourceType, t.resourceId) }),
);

/**
 * 智能体的知识文档。
 * 与会话工作空间的区别:工作空间是每会话独立且开局为空,知识库是智能体级、跨会话长存。
 */
export const knowledgeDocs = mysqlTable(
  "knowledge_docs",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    agentId: varchar("agent_id", { length: 36 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    /**
     * 原文。切块与索引在读取时算 —— 文档量级不大时省掉一层一致性维护。
     * MEDIUMTEXT:接口允许 20 万字符,中文按 3 字节算远超 TEXT 的 64KB。
     */
    content: mediumtext("content").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({ byAgent: index("idx_knowledge_agent").on(t.agentId) }),
);

/** 用户组:让"分享给整个团队"成为可能,而不必逐个点人。 */
export const groups = mysqlTable(
  "groups",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    description: varchar("description", { length: 1024 }),
    ownerId: varchar("owner_id", { length: 36 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({ byOwner: index("idx_groups_owner").on(t.ownerId) }),
);

/**
 * 组成员。
 * (group_id, user_id) 唯一 —— 同一人重复加入会让授权判定与成员计数都出错。
 */
export const groupMembers = mysqlTable(
  "group_members",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    groupId: varchar("group_id", { length: 36 }).notNull(),
    userId: varchar("user_id", { length: 36 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    uniqMember: uniqueIndex("uniq_group_member").on(t.groupId, t.userId),
    byUser: index("idx_group_members_user").on(t.userId),
  }),
);

/**
 * 审计日志:只追加。谁(actor)在什么时候对什么资源(resource)做了什么(action)。
 * owner_id 是资源归属账号,决定谁能看到(归属人、操作者本人、管理员)。
 * 时间用毫秒整数:键集分页需要比 timestamp 的秒级更细的序。
 */
export const auditLogs = mysqlTable(
  "audit_logs",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    atMs: bigint("at_ms", { mode: "number" }).notNull(),
    actorType: varchar("actor_type", { length: 16 }).notNull(),
    actorId: varchar("actor_id", { length: 36 }),
    actorLabel: varchar("actor_label", { length: 255 }),
    action: varchar("action", { length: 64 }).notNull(),
    resourceType: varchar("resource_type", { length: 32 }).notNull(),
    resourceId: varchar("resource_id", { length: 64 }),
    ownerId: varchar("owner_id", { length: 36 }),
    details: json("details"),
    ip: varchar("ip", { length: 64 }),
    userAgent: varchar("user_agent", { length: 256 }),
  },
  (t) => ({
    byOwner: index("idx_audit_owner").on(t.ownerId, t.atMs),
    byActor: index("idx_audit_actor").on(t.actorId, t.atMs),
    byResource: index("idx_audit_resource").on(t.resourceType, t.resourceId, t.atMs),
    byTime: index("idx_audit_time").on(t.atMs),
  }),
);

/**
 * Webhook 投递记录:每次真正发出(或被拦下)的回调一行,供集成方排查对接问题。
 * url 只存协议 + 主机 + 路径 —— 查询串与用户信息常带着接收方的令牌,不落库。
 * agent_id 决定谁能看:智能体所有者与管理员(与"谁能设回调地址"一致)。
 */
export const webhookDeliveries = mysqlTable(
  "webhook_deliveries",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    agentId: varchar("agent_id", { length: 36 }).notNull(),
    /** 测试投递为空 */
    runId: varchar("run_id", { length: 36 }),
    /** auto = 发件箱自动投递(含手动重发后的那次);test = 测试投递 */
    trigger: varchar("trigger", { length: 16 }).notNull(),
    /** 发件箱第几次认领(测试投递为空) */
    attempt: int("attempt"),
    url: varchar("url", { length: 512 }).notNull(),
    /** 对方返回的 HTTP 状态;没收到响应(网络错误、被拦)为空 */
    httpStatus: int("http_status"),
    ok: int("ok").notNull(),
    error: varchar("error", { length: 512 }),
    durationMs: int("duration_ms").notNull(),
    signed: int("signed").notNull(),
    atMs: bigint("at_ms", { mode: "number" }).notNull(),
  },
  (t) => ({
    byAgent: index("idx_webhook_deliveries_agent").on(t.agentId, t.atMs),
    byRun: index("idx_webhook_deliveries_run").on(t.runId),
  }),
);
