// Drizzle schema — 对应设计文档 §5 数据模型的 9 张表。
// JSON 列承载灵活配置;金额/token 一律整数或字符串,不用 float。

import { bigint, index, int, json, mysqlTable, timestamp, varchar } from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: varchar("id", { length: 36 }).primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  role: varchar("role", { length: 16 }).notNull().default("user"),
  defaultBaseUrl: varchar("default_base_url", { length: 512 }),
  /** 每用户自带的 Anthropic key,加密入库 */
  anthropicKeyEnc: varchar("anthropic_key_enc", { length: 1024 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const assistants = mysqlTable(
  "assistants",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    ownerId: varchar("owner_id", { length: 36 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    icon: varchar("icon", { length: 64 }),
    description: varchar("description", { length: 1024 }),
    /** AssistantConfig:systemPrompt/skills/mcpServers/tools/subagents/model/effort/maxTurns */
    config: json("config").notNull(),
    inputSchema: json("input_schema"),
    /** 定义了才能被企业系统当接口消费(设计文档 §3) */
    outputSchema: json("output_schema"),
    verifyRules: json("verify_rules"),
    webhookUrl: varchar("webhook_url", { length: 1024 }),
    visibility: varchar("visibility", { length: 16 }).notNull().default("private"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({ byOwner: index("idx_assistants_owner").on(t.ownerId) }),
);

/** 会话 = 项目 = 工作目录,一对一。 */
export const sessions = mysqlTable(
  "sessions",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    assistantId: varchar("assistant_id", { length: 36 }).notNull(),
    /** 人用时归属用户 */
    ownerId: varchar("owner_id", { length: 36 }),
    /** 系统 invoke 时归属调用方 key */
    callerApiKeyId: varchar("caller_api_key_id", { length: 36 }),
    workspaceDir: varchar("workspace_dir", { length: 512 }).notNull(),
    /** 上一轮 SDK session id,多轮 resume 用 */
    sdkSessionId: varchar("sdk_session_id", { length: 128 }),
    title: varchar("title", { length: 255 }),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    /** 会话级凭证覆盖(三级链中间层) */
    baseUrl: varchar("base_url", { length: 512 }),
    keyEnc: varchar("key_enc", { length: 1024 }),
    model: varchar("model", { length: 32 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    byAssistant: index("idx_sessions_assistant").on(t.assistantId),
    byOwner: index("idx_sessions_owner").on(t.ownerId),
  }),
);

export const messages = mysqlTable(
  "messages",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    sessionId: varchar("session_id", { length: 36 }).notNull(),
    role: varchar("role", { length: 16 }).notNull(),
    content: json("content").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({ bySession: index("idx_messages_session").on(t.sessionId) }),
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
    prompt: varchar("prompt", { length: 8192 }).notNull().default(""),
    /** 租约到期时间戳(ms)。NULL = 未认领或已完成 */
    leaseUntil: bigint("lease_until", { mode: "number" }),
    /** 被认领的次数,用于识别反复崩溃的任务 */
    attempts: int("attempts").notNull().default(0),
    structuredResult: json("structured_result"),
    cost: json("cost"),
    errorInfo: json("error_info"),
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    byClaim: index("idx_runs_claim").on(t.status, t.leaseUntil),
    bySession: index("idx_runs_session").on(t.sessionId),
  }),
);

export const artifacts = mysqlTable(
  "artifacts",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    sessionId: varchar("session_id", { length: 36 }).notNull(),
    path: varchar("path", { length: 1024 }).notNull(),
    mime: varchar("mime", { length: 128 }),
    size: bigint("size", { mode: "number" }),
    storageUrl: varchar("storage_url", { length: 1024 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({ bySession: index("idx_artifacts_session").on(t.sessionId) }),
);

export const apiKeys = mysqlTable(
  "api_keys",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    assistantId: varchar("assistant_id", { length: 36 }),
    ownerId: varchar("owner_id", { length: 36 }).notNull(),
    /** 只存哈希,明文只在创建时返回一次 */
    hashedKey: varchar("hashed_key", { length: 128 }).notNull().unique(),
    name: varchar("name", { length: 255 }),
    quota: json("quota"),
    lastUsedAt: timestamp("last_used_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({ byOwner: index("idx_api_keys_owner").on(t.ownerId) }),
);

/** 通用授权:一张表覆盖 assistants/sessions 等资源;principalId="*" 表示 public。 */
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

/** 工具级每用户配置(admin 全局 + 每用户两层里的用户层)。 */
export const userValves = mysqlTable(
  "user_valves",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: varchar("user_id", { length: 36 }).notNull(),
    toolId: varchar("tool_id", { length: 128 }).notNull(),
    config: json("config").notNull(),
  },
  (t) => ({ byUser: index("idx_valves_user").on(t.userId) }),
);
