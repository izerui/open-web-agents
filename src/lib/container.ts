// Composition root:手工装配端口 → adapter。不用 DI 框架。
//
// 这是全工程唯一决定"用哪个实现"的地方 —— 换 DB / 换总线 / 换引擎都只改这里。

import { createHmac, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { type Db, createDb } from "@/lib/db/client";
import { type Env, loadEnv } from "@/lib/env";
import { MysqlGrantRepo } from "@/lib/modules/access/adapters/mysql-grant-repo";
import { MysqlGroupRepo } from "@/lib/modules/access/adapters/mysql-group-repo";
import { Authorizer, WEB_USER_ID } from "@/lib/modules/access/application/authorize";
import { PUBLIC_PRINCIPAL } from "@/lib/modules/access/domain/grants";
import type { GroupRepo } from "@/lib/modules/access/group-ports";
import type { GrantRepo } from "@/lib/modules/access/ports";
import { createClaudeSdkEngine } from "@/lib/modules/agent-engine/adapters/claude-sdk/default-engine";
import { JsonlTranscript } from "@/lib/modules/agent-engine/adapters/claude-sdk/jsonl-transcript";
import type { EngineDeps } from "@/lib/modules/agent-engine/adapters/claude-sdk/runner";
import type { EnginePort, TranscriptPort } from "@/lib/modules/agent-engine/ports";
import { readBundle, writeBundle } from "@/lib/modules/agent/adapters/fs-bundle-store";
import { MysqlAgentRepo } from "@/lib/modules/agent/adapters/mysql-agent-repo";
import { MysqlAgentVersionRepo } from "@/lib/modules/agent/adapters/mysql-agent-version-repo";
import { AgentReleases } from "@/lib/modules/agent/application/releases";
import { ARCHITECT_AGENT_ID, ARCHITECT_CONFIG } from "@/lib/modules/agent/domain/architect";
import type { AgentRepo } from "@/lib/modules/agent/ports";
import { RedisApproval } from "@/lib/modules/approval/adapters/redis-approval";
import { type ApprovalPort, ApprovalUnavailable } from "@/lib/modules/approval/ports";
import { LocalFsStorage } from "@/lib/modules/artifacts/adapters/local-fs-storage";
import { RedisGcLock } from "@/lib/modules/artifacts/adapters/redis-gc-lock";
import { WorkspaceGc } from "@/lib/modules/artifacts/application/gc";
import type { StoragePort } from "@/lib/modules/artifacts/ports";
import { MysqlAuditRepo } from "@/lib/modules/audit/adapters/mysql-audit-repo";
import { AuditLog } from "@/lib/modules/audit/application/audit-log";
import { RedisBus } from "@/lib/modules/events/adapters/redis-bus";
import type { BusPort } from "@/lib/modules/events/ports";
import { MysqlApiKeyRepo } from "@/lib/modules/identity/adapters/mysql-api-key-repo";
import { MysqlUserRepo } from "@/lib/modules/identity/adapters/mysql-user-repo";
import {
  type RateLimiter,
  RedisRateLimiter,
} from "@/lib/modules/identity/adapters/redis-rate-limiter";
import { AuthService } from "@/lib/modules/identity/application/auth-service";
import { SecretBox } from "@/lib/modules/identity/domain/secret-box";
import type { ApiKeyRepo } from "@/lib/modules/identity/ports";
import type { UserRepo } from "@/lib/modules/identity/user-ports";
import { createGuardedSender } from "@/lib/modules/integration/adapters/guarded-http-sender";
import { deliverWebhook } from "@/lib/modules/integration/application/webhook";
import { WebhookDispatcher } from "@/lib/modules/integration/application/webhook-dispatcher";
import { isAddressAllowed } from "@/lib/modules/integration/domain/webhook-policy";
import { MysqlKnowledgeRepo } from "@/lib/modules/knowledge/adapters/mysql-knowledge-repo";
import { ChunkCache } from "@/lib/modules/knowledge/application/chunk-cache";
import { formatContext, retrieve } from "@/lib/modules/knowledge/domain/retrieval";
import { EnvModelGateway } from "@/lib/modules/model-gateway/adapters/env-gateway";
import type { ModelGatewayPort } from "@/lib/modules/model-gateway/ports";
import { MysqlRunQuery } from "@/lib/modules/run/adapters/mysql-run-query";
import { MysqlRunRepo } from "@/lib/modules/run/adapters/mysql-run-repo";
import { RedisCancelSignal } from "@/lib/modules/run/adapters/redis-cancel-signal";
import { RunEnqueuer } from "@/lib/modules/run/application/enqueue";
import {
  type RunCommand,
  RunOrchestrator,
  topicOf,
} from "@/lib/modules/run/application/orchestrator";
import { RunWorker } from "@/lib/modules/run/application/worker";
import type { CancelSignal } from "@/lib/modules/run/ports";
import { MysqlSessionRepo } from "@/lib/modules/session/adapters/mysql-session-repo";
import type { SessionRepo } from "@/lib/modules/session/ports";
import { MysqlUsageRepo } from "@/lib/modules/usage/adapters/mysql-usage-repo";
import { QuotaExceeded, assertWithinQuota } from "@/lib/modules/usage/application/quota-guard";

export interface Container {
  env: Env;
  /**
   * 嵌入令牌的签名密钥,由 sessionSecret 派生而不是直接复用 —— 登录 cookie 与嵌入令牌
   * 用同一把密钥签名,任一种格式的解析缺陷都可能让另一种被伪造。
   */
  embedSecret: string;
  db: Db;
  sessions: SessionRepo;
  agents: AgentRepo;
  /** 版本与发布:发布、回滚、载入草稿,以及每个入口该跑哪一版。 */
  releases: AgentReleases;
  bus: BusPort;
  engine: EnginePort;
  gateway: ModelGatewayPort;
  storage: StoragePort;
  /** 读 SDK 落盘的会话过程记录,供历史回放。 */
  transcript: TranscriptPort;
  approval: ApprovalPort;
  gc: WorkspaceGc;
  apiKeys: ApiKeyRepo;
  grants: GrantRepo;
  groups: GroupRepo;
  users: UserRepo;
  secrets: SecretBox;
  authService: AuthService;
  auth: Authorizer;
  runs: MysqlRunRepo;
  /** 运行记录查询(读模型)。 */
  runQuery: MysqlRunQuery;
  usage: MysqlUsageRepo;
  knowledge: MysqlKnowledgeRepo;
  orchestrator: RunOrchestrator;
  /** 所有发起运行的入口都经它入队(限长、配置快照、加密覆盖、幂等)。 */
  enqueuer: RunEnqueuer;
  worker: RunWorker;
  /** 回调发件箱投递器。与 worker 同进程启动。 */
  webhooks: WebhookDispatcher;
  /** 取消通知:取消接口落库后发出,执行中的 worker 立即中止。 */
  cancelSignal: CancelSignal;
  /** 登录、注册等入口的限流。 */
  rateLimiter: RateLimiter;
  /** 审计日志:谁在什么时候对什么做了什么。操作成功后由路由记录。 */
  audit: AuditLog;
  /** 设计会话工作目录里的智能体包读写。 */
  bundles: {
    read(workspaceDir: string): Promise<Record<string, string>>;
    write(workspaceDir: string, files: Record<string, string>): Promise<void>;
  };
}

/** 人工审批的等待上限。到点自动拒绝,避免 worker 被无人值守的审批永久占住。 */
const APPROVAL_TIMEOUT_MS = 10 * 60_000;

/**
 * 内置的通用智能体:未定义 outputSchema,故只回对话文本(设计文档 §3)。
 * 智能体构建器接入后改为从库里读。
 */
const DEFAULT_AGENT = {
  id: "default",
  // 平台内置,归 system 所有;通过公开授权让所有人可用(见 build())
  ownerId: "system",
  name: "通用智能体",
  description: "可对话、可用工具在会话工作目录里干活的通用智能体",
  config: {
    systemPrompt: [
      "你是 Open Web Agents 平台上的通用智能体。",
      "你在一个独立的会话工作目录里工作,可以自由读写其中的文件。",
      "回答简洁,用中文。",
    ].join("\n"),
    model: "sonnet" as const,
    maxTurns: 20,
  },
};

/**
 * 宿主环境里可安全继承给 agent 子进程的部分。
 *
 * 必须继承 PATH 等,否则子进程连基本命令都跑不了;但要剔除平台自己的密钥
 * (OWA_*)与宿主的 ANTHROPIC_*,避免越过三级凭证链泄露到 agent。
 */
function inheritedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith("OWA_") || k.startsWith("ANTHROPIC_")) continue;
    out[k] = v;
  }
  return out;
}

function build(): Container {
  const env = loadEnv();
  const { db } = createDb(env.databaseUrl);

  const gateway = new EnvModelGateway({
    base: env.models.base,
    fable: env.models.fable,
    opus: env.models.opus,
    sonnet: env.models.sonnet,
    haiku: env.models.haiku,
  });

  const sessions = new MysqlSessionRepo(db);
  const agents = new MysqlAgentRepo(db);
  const releases = new AgentReleases(agents, new MysqlAgentVersionRepo(db));
  // 首次启动播种内置智能体,保证开箱可用;已存在则覆盖为最新定义。
  // 它归 system 所有,故必须同时授予公开 read —— 否则新注册用户在列表里看不到它。
  void agents
    .upsert(DEFAULT_AGENT)
    .then(() =>
      grants.grant({
        id: "grant-default-public",
        resourceType: "agent",
        resourceId: DEFAULT_AGENT.id,
        principalType: "*",
        principalId: PUBLIC_PRINCIPAL,
        permission: "read",
      }),
    )
    .catch(() => {});
  // 内置"AI 智能体设计师":所有人可用,通过对话设计其它智能体(见 agent/domain/architect.ts)
  void agents
    .upsert({
      id: ARCHITECT_AGENT_ID,
      ownerId: "system",
      name: "AI 智能体设计师",
      description: "通过对话设计、完善你的智能体:提示词、技能、MCP、契约",
      config: ARCHITECT_CONFIG,
    })
    .then(() =>
      grants.grant({
        id: "grant-architect-public",
        resourceType: "agent",
        resourceId: ARCHITECT_AGENT_ID,
        principalType: "*",
        principalId: PUBLIC_PRINCIPAL,
        permission: "read",
      }),
    )
    .catch(() => {});
  const bus = new RedisBus(env.redisUrl);
  const runs = new MysqlRunRepo(db);
  const storage = new LocalFsStorage();
  const transcript = new JsonlTranscript();
  const approval = new RedisApproval(env.redisUrl);
  const usage = new MysqlUsageRepo(db);
  const knowledge = new MysqlKnowledgeRepo(db);
  const knowledgeChunks = new ChunkCache(knowledge);
  const apiKeys = new MysqlApiKeyRepo(db);
  const grants = new MysqlGrantRepo(db);
  const groupRepo = new MysqlGroupRepo(db);
  const users = new MysqlUserRepo(db);
  const secrets = new SecretBox(env.secretKey);
  const authService = new AuthService({
    users,
    sessionSecret: env.sessionSecret,
    secureCookie: process.env.NODE_ENV === "production",
    allowSignup: env.allowSignup,
  });
  const rateLimiter = new RedisRateLimiter(env.redisUrl);
  const auth = new Authorizer({
    apiKeys,
    sessions,
    agents,
    grants,
    authRequired: env.authRequired,
    currentUser: (req) => authService.currentUser(req),
    groupIdsOf: (userId) => groupRepo.groupIdsOf(userId),
    isUserActive: async (userId) => {
      // 关闭登录的本地开发模式下,key 归属于没有账号行的固定主体
      if (!env.authRequired && userId === WEB_USER_ID) return true;
      const u = await users.get(userId);
      return !!u && !u.disabled;
    },
  });
  // 审批钩子:先把待审事件推上总线(界面才看得到),再挂起等裁决。
  // 超时兜底在 RedisApproval 里 —— 没人审批时到点自动拒,绝不永久占住 worker。
  const requestApproval: NonNullable<EngineDeps["requestApproval"]> = async (r, signal) => {
    const id = randomUUID().replace(/-/g, "").slice(0, 24);
    const expiresAt = Date.now() + APPROVAL_TIMEOUT_MS;

    await bus
      .publish(topicOf(r.sessionId, r.runId), {
        kind: "status",
        label: `待审批:${r.toolName} — ${r.summary}(${r.reason})`,
        state: "awaiting_approval",
      })
      .catch(() => {});

    let outcome: Awaited<ReturnType<typeof approval.request>>;
    try {
      outcome = await approval.request(
        {
          id,
          sessionId: r.sessionId,
          runId: r.runId,
          toolName: r.toolName,
          summary: r.summary,
          reason: r.reason,
          createdAt: Date.now(),
          expiresAt,
        },
        // 运行被取消/超时中止时,这条待审请求要立刻收场并清掉 Redis 记录 ——
        // 否则界面上它还挂着,用户点批准还会收到"已裁决",而运行早就没了
        signal,
      );
    } catch (err) {
      // 审批服务不可用:如实标成"无法确认",不冒充超时拒绝。异常继续抛给引擎,
      // 由它按 fail-closed 拒绝这次工具调用并带上原因
      if (err instanceof ApprovalUnavailable) {
        await bus
          .publish(topicOf(r.sessionId, r.runId), {
            kind: "status",
            label: `审批结果无法确认(审批服务不可用):${r.toolName}`,
            state: "approval_unavailable",
          })
          .catch(() => {});
      }
      throw err;
    }

    const label =
      outcome.decision === "approved"
        ? `审批通过:${r.toolName}`
        : outcome.decision === "expired"
          ? `审批超时自动拒绝:${r.toolName}`
          : `审批被拒:${r.toolName}`;
    await bus
      .publish(topicOf(r.sessionId, r.runId), { kind: "status", label, state: outcome.decision })
      .catch(() => {});

    return {
      approved: outcome.decision === "approved",
      message:
        outcome.decision === "expired"
          ? "审批超时,已自动拒绝"
          : outcome.decision === "denied"
            ? (outcome.message ?? "人工审批未通过")
            : undefined,
    };
  };
  const engine = createClaudeSdkEngine(
    env.dataDir,
    gateway,
    env.sandbox,
    env.allowStdioMcp,
    requestApproval,
  );

  const orchestrator = new RunOrchestrator({
    sessions,
    agents,
    engine,
    bus,
    platformCredentials: { baseUrl: env.defaultBaseUrl, key: env.defaultApiKey },
    // agent 子进程需要继承宿主环境(PATH 等),否则 Bash 里连 ls 都找不到。
    // 凭证与 HOME 会在 buildSdkOptions 里覆盖掉这里的同名项。
    baseEnv: inheritedEnv(),
    runAnchor: (runId) => runs.getResumeAnchor(runId),
    recordRunSession: (runId, sdkSessionId) => runs.setSdkSessionId(runId, sdkSessionId),
    recordRunAnchor: (runId, anchor) => runs.setResumeAnchor(runId, anchor),
    ensureWorkspace: async (dir) => {
      await fs.mkdir(dir, { recursive: true });
    },
    // 知识检索:没有文档或没命中都返回空串,上层据此决定不注入
    retrieveKnowledge: async (agentId, query) => {
      const chunks = await knowledgeChunks.chunksOf(agentId);
      if (chunks.length === 0) return "";
      return formatContext(retrieve(query, chunks));
    },
    quotaCheck: async (userId) => {
      try {
        await assertWithinQuota({ users, usage }, userId);
        return { allowed: true };
      } catch (err) {
        if (err instanceof QuotaExceeded) return { allowed: false, reason: err.message };
        throw err;
      }
    },
    // 用户自带凭证:未配置时返回空对象并回落平台默认;已配置却无法解密时必须失败,
    // 避免在用户不知情时改用平台共享 key、造成计费归属错误。
    userCredentials: async (userId) => {
      const u = await users.get(userId);
      if (!u) return {};
      if (!u.anthropicKeyEnc) return { baseUrl: u.defaultBaseUrl };

      const key = secrets.decrypt(u.anthropicKeyEnc);
      if (key === null) {
        throw new Error(`用户凭证无法解密(user=${userId}),请重新保存凭证`);
      }
      return { baseUrl: u.defaultBaseUrl, key };
    },
  });

  // 同进程内起 worker。拆成独立进程时,web 侧用 OWA_EMBEDDED_WORKER=0 关掉,
  // 由 worker 入口(src/worker.ts)单独起 —— worker 无本地状态,代码完全不变。
  const cancelSignal = new RedisCancelSignal(env.redisUrl);
  const enqueuer = new RunEnqueuer({
    runs,
    sessions,
    agents,
    releases,
    encryptOverride: (o) => secrets.encrypt(JSON.stringify(o)),
  });

  const worker = new RunWorker(
    runs,
    orchestrator,
    { concurrency: env.workerConcurrency },
    {
      cancelSignal,
      decodeOverride: (enc) => {
        const plain = secrets.decrypt(enc);
        // 解不开就失败,绝不悄悄回落到平台凭证 —— 那会让调用方的花费记错账
        if (plain === null) throw new Error("请求级凭证覆盖无法解密(主密钥可能已更换)");
        return JSON.parse(plain) as RunCommand["override"];
      },
      // 终态已落库,再发布 result 事件:SSE 看到的结局与数据库一致
      onFinalized: async ({ runId, sessionId, state, result }) => {
        await bus.publish(topicOf(sessionId, runId), {
          kind: "result",
          status: state === "success" ? "success" : state === "cancelled" ? "cancelled" : "failed",
          structured: result.structured,
          summary: result.summary ?? result.error?.message,
          runId,
        });
      },
    },
  );

  // 地址校验接在连接自己的 DNS lookup 上:被检查的地址就是被连接的地址
  const webhookSender = createGuardedSender({
    allowAddress: (ip) => isAddressAllowed(ip, env.webhookAllowPrivate),
  });
  const webhooks = new WebhookDispatcher({
    outbox: runs,
    loadTarget: async (sessionId) => {
      const session = await sessions.get(sessionId);
      // 回调是给集成方的:只推系统发起的运行(接口调用、API 会话)。
      // 曾经对每个运行都推 —— 被分享者在工作台里的对话、访客在嵌入组件里的对话,
      // 最终回答都会被推到智能体所有者的地址上
      if (!session || (session.source !== "invoke" && session.source !== "api")) return null;
      const agent = await agents.get(session.agentId);
      if (!agent?.webhookUrl) return null;
      // 用智能体所有者的签名密钥。配置了却解不开就抛错 —— 不能退化成不签名照发
      const owner = await users.get(agent.ownerId);
      if (!owner?.webhookSecretEnc) return { url: agent.webhookUrl };
      const secret = secrets.decrypt(owner.webhookSecretEnc);
      if (secret === null) throw new Error(`webhook 签名密钥无法解密(user=${agent.ownerId})`);
      return { url: agent.webhookUrl, secret };
    },
    loadPayload: async (runId, sessionId) => {
      const r = await runs.getResult(runId);
      if (!r) return null;
      const session = await sessions.get(sessionId);
      return {
        deliveryId: runId,
        event: "run.finished",
        taskId: runId,
        sessionId,
        agentId: session?.agentId,
        agentVersion: r.agentVersion ?? undefined,
        status: r.status,
        structured: r.structured ?? undefined,
        summary: r.summary ?? undefined,
        error: r.error ?? undefined,
        cost: r.cost ?? undefined,
      };
    },
    deliver: (url, payload, secret) =>
      deliverWebhook(url, payload, { secret, maxAttempts: 2, send: webhookSender }),
  });

  if (process.env.OWA_EMBEDDED_WORKER !== "0") {
    worker.start();
    webhooks.start();
  }

  // 工作空间 GC:定期两层回收,防磁盘无界增长。失败只记日志,绝不影响主流程。
  const gcLock = new RedisGcLock(env.redisUrl);
  const gc = new WorkspaceGc({
    workspacesRoot: path.join(env.dataDir, "workspaces"),
    listWorkspaces: () => runs.listSessionActivity(),
    markPurged: (id, opts) => sessions.markWorkspacePurged(id, opts),
    acquireLock: () => gcLock.acquire(),
  });
  const gcTimer = setInterval(() => {
    void gc
      .run()
      .then((r) => {
        if (r.cleaned || r.purged) {
          console.log(
            `[owa][gc] 扫描 ${r.scanned} 清理 ${r.cleaned} 删除 ${r.purged} 释放 ${Math.round(r.freedBytes / 1024)}KB`,
          );
        }
        for (const e of r.errors) console.warn(`[owa][gc] ${e}`);
      })
      .catch((e) => console.warn("[owa][gc] 失败:", e));
  }, 30 * 60_000);
  // 进程退出时别把定时器留着(dev 热重载会反复建 container)
  gcTimer.unref?.();

  return {
    env,
    embedSecret: createHmac("sha256", env.sessionSecret).update("owa-embed-token-v1").digest("hex"),
    db,
    sessions,
    agents,
    releases,
    bus,
    engine,
    gateway,
    storage,
    transcript,
    approval,
    gc,
    apiKeys,
    grants,
    groups: groupRepo,
    users,
    secrets,
    authService,
    auth,
    runs,
    runQuery: new MysqlRunQuery(db),
    usage,
    knowledge,
    orchestrator,
    enqueuer,
    worker,
    webhooks,
    cancelSignal,
    rateLimiter,
    bundles: { read: readBundle, write: writeBundle },
    audit: new AuditLog({
      repo: new MysqlAuditRepo(db),
      emailOf: async (id) => (await users.get(id))?.email,
    }),
  };
}

// dev 下 Next 会热重载模块,挂到 globalThis 上避免连接池与 worker 被重复创建
//
// 【代价:给 adapter 加方法后 dev 必须重启】容器只 build 一次就一直挂在 globalThis 上,
// 热重载换掉的是模块代码,换不掉已经实例化的对象 —— 于是新方法在旧实例上不存在,
// 路由里调用会抛 "xxx is not a function",接口 500、前端拿到空响应体,
// 看起来就像"数据全没了"。生产是一次性构建启动,不会遇到。
const g = globalThis as { __owaContainer?: Container };

export function getContainer(): Container {
  g.__owaContainer ??= build();
  return g.__owaContainer;
}
