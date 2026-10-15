// Composition root:手工装配端口 → adapter。不用 DI 框架。
//
// 这是全工程唯一决定"用哪个实现"的地方 —— 换 DB / 换总线 / 换引擎都只改这里。

import { createHmac, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { type Db, createDb, databaseProbe } from "@/lib/db/client";
import { designTransaction } from "@/lib/design-transaction";
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
import { AgentDesigner } from "@/lib/modules/agent/application/designer";
import { AgentReleases } from "@/lib/modules/agent/application/releases";
import { seedBuiltin } from "@/lib/modules/agent/application/seed-builtin";
import { ARCHITECT_AGENT_ID, ARCHITECT_CONFIG } from "@/lib/modules/agent/domain/architect";
import { validateInput } from "@/lib/modules/agent/domain/validate-output";
import type { Agent } from "@/lib/modules/agent/ports";
import type { AgentRepo } from "@/lib/modules/agent/ports";
import { RedisApproval } from "@/lib/modules/approval/adapters/redis-approval";
import { requestApproval as requestApprovalWithGrants } from "@/lib/modules/approval/application/request-approval";
import { type ApprovalPort, ApprovalUnavailable } from "@/lib/modules/approval/ports";
import { LocalFsStorage } from "@/lib/modules/artifacts/adapters/local-fs-storage";
import { RedisGcLock } from "@/lib/modules/artifacts/adapters/redis-gc-lock";
import { WorkspaceGc } from "@/lib/modules/artifacts/application/gc";
import { taskFilesForResult } from "@/lib/modules/artifacts/application/task-files";
import type { StoragePort } from "@/lib/modules/artifacts/ports";
import { MysqlAuditRepo } from "@/lib/modules/audit/adapters/mysql-audit-repo";
import { AuditLog } from "@/lib/modules/audit/application/audit-log";
import { MysqlBillingRepo } from "@/lib/modules/billing/adapters/mysql-billing-repo";
import { MysqlPackageRepo } from "@/lib/modules/billing/adapters/mysql-package-repo";
import type { PackageRepo } from "@/lib/modules/billing/package-ports";
import type { BillingRepo } from "@/lib/modules/billing/ports";
import { MysqlCapabilityRepo } from "@/lib/modules/capabilities/adapters/mysql-capability-repo";
import type { CapabilityRepo } from "@/lib/modules/capabilities/ports";
import { MysqlEvalRepo } from "@/lib/modules/eval/adapters/mysql-eval-repo";
import type { EvalDeps } from "@/lib/modules/eval/application/eval-runner";
import type { EvalRepo } from "@/lib/modules/eval/ports";
import { RedisBus } from "@/lib/modules/events/adapters/redis-bus";
import type { BusPort } from "@/lib/modules/events/ports";
import { MysqlApiKeyRepo } from "@/lib/modules/identity/adapters/mysql-api-key-repo";
import { MysqlUserRepo } from "@/lib/modules/identity/adapters/mysql-user-repo";
import {
  type RateLimiter,
  RedisRateLimiter,
} from "@/lib/modules/identity/adapters/redis-rate-limiter";
import { AuthService } from "@/lib/modules/identity/application/auth-service";
import { checkInvokeRate } from "@/lib/modules/identity/application/invoke-rate-limit";
import { SecretBox } from "@/lib/modules/identity/domain/secret-box";
import type { ApiKeyRepo } from "@/lib/modules/identity/ports";
import type { UserRepo } from "@/lib/modules/identity/user-ports";
import { createGuardedSender } from "@/lib/modules/integration/adapters/guarded-http-sender";
import { MysqlWebhookDeliveryLog } from "@/lib/modules/integration/adapters/mysql-webhook-delivery-log";
import { deliverWebhook, runFinishedPayload } from "@/lib/modules/integration/application/webhook";
import { WebhookConsole } from "@/lib/modules/integration/application/webhook-console";
import { WebhookDispatcher } from "@/lib/modules/integration/application/webhook-dispatcher";
import { resolveRunTarget } from "@/lib/modules/integration/application/webhook-target";
import { signingSecretsOf } from "@/lib/modules/integration/domain/signing-secrets";
import { isAddressAllowed } from "@/lib/modules/integration/domain/webhook-policy";
import { MysqlKnowledgeRepo } from "@/lib/modules/knowledge/adapters/mysql-knowledge-repo";
import { ChunkCache } from "@/lib/modules/knowledge/application/chunk-cache";
import { formatContext, retrieve } from "@/lib/modules/knowledge/domain/retrieval";
import { EnvModelGateway } from "@/lib/modules/model-gateway/adapters/env-gateway";
import type { ModelGatewayPort } from "@/lib/modules/model-gateway/ports";
import { MysqlRunQuery } from "@/lib/modules/run/adapters/mysql-run-query";
import { MysqlRunRepo } from "@/lib/modules/run/adapters/mysql-run-repo";
import { RedisCancelSignal } from "@/lib/modules/run/adapters/redis-cancel-signal";
import { RedisSteerChannel } from "@/lib/modules/run/adapters/redis-steer-channel";
import { AdmissionRejected, RunAdmission } from "@/lib/modules/run/application/admission";
import { RunEnqueuer } from "@/lib/modules/run/application/enqueue";
import {
  type RunCommand,
  RunOrchestrator,
  topicOf,
} from "@/lib/modules/run/application/orchestrator";
import { RunWorker } from "@/lib/modules/run/application/worker";
import type { CancelSignal, SteerChannel } from "@/lib/modules/run/ports";
import { MysqlSessionRepo } from "@/lib/modules/session/adapters/mysql-session-repo";
import { workspacePathFor } from "@/lib/modules/session/domain/workspace";
import type { SessionRepo } from "@/lib/modules/session/ports";
import { MysqlUsageRepo } from "@/lib/modules/usage/adapters/mysql-usage-repo";
import { QuotaExceeded, assertWithinQuota } from "@/lib/modules/usage/application/quota-guard";
import { mysqlSeedInRowLock } from "@/lib/seed-in-row-lock";

export interface Container {
  env: Env;
  /**
   * 嵌入令牌的签名密钥,由 sessionSecret 派生而不是直接复用 —— 登录 cookie 与嵌入令牌
   * 用同一把密钥签名,任一种格式的解析缺陷都可能让另一种被伪造。
   */
  embedSecret: string;
  db: Db;
  /** 健康检查的数据库探测(单一在途,等待上限由路由处理) */
  probeDatabase: () => Promise<void>;
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
  /** 在已有会话里受理新一轮的统一关卡(计费账号、Key 限流、额度、输入与契约)。 */
  admission: RunAdmission;
  worker: RunWorker;
  /** 回调发件箱投递器。与 worker 同进程启动。 */
  webhooks: WebhookDispatcher;
  /** 投递记录、测试投递、手动重发。 */
  webhookConsole: WebhookConsole;
  evals: EvalRepo;
  /** 发起 / 读取评测用到的依赖(见 eval/application/eval-runner.ts) */
  evalDeps: EvalDeps;
  /** 取消通知:取消接口落库后发出,执行中的 worker 立即中止。 */
  cancelSignal: CancelSignal;
  steerChannel: SteerChannel;
  /** 登录、注册等入口的限流。 */
  rateLimiter: RateLimiter;
  /** 审计日志:谁在什么时候对什么做了什么。操作成功后由路由记录。 */
  audit: AuditLog;
  /** 设计会话工作目录里的智能体包读写。 */
  bundles: {
    read(workspaceDir: string): Promise<Record<string, string>>;
    write(workspaceDir: string, files: Record<string, string>): Promise<void>;
  };
  designer: AgentDesigner;
  capabilities: CapabilityRepo;
  billing: BillingRepo;
  packages: PackageRepo;
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
  const probeDatabase = databaseProbe(db);

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
  // 内置智能体:首次写入定义;之后没人改过就升级到代码里的新定义,有人改过就保留(见 seed-builtin.ts)。
  // 它们归 system 所有,首次写入时(同一事务里)授予公开只读 —— 否则新注册用户在列表里看不到
  const seedPublic = (definition: Agent, grantId: string) =>
    seedBuiltin(
      {
        inRowLock: mysqlSeedInRowLock(db, {
          id: grantId,
          resourceType: "agent",
          resourceId: definition.id,
          principalType: "*",
          principalId: PUBLIC_PRINCIPAL,
          permission: "read",
        }),
      },
      definition,
    ).catch((err) =>
      console.warn(
        `[owa] 写入内置智能体 ${definition.id} 失败:`,
        err instanceof Error ? err.message : err,
      ),
    );
  void seedPublic(DEFAULT_AGENT, "grant-default-public");
  // 私有执行器保留历史实体;新运行始终使用代码中的受限配置。
  void seedBuiltin(
    {
      inRowLock: (fn) =>
        db.transaction(async (tx) => {
          const txDb = tx as unknown as Db;
          await new MysqlGrantRepo(txDb).revokeAllForResource("agent", ARCHITECT_AGENT_ID);
          return fn({
            agents: new MysqlAgentRepo(txDb),
            grantPublicRead: async () => {},
          });
        }),
    },
    {
      id: ARCHITECT_AGENT_ID,
      ownerId: "system",
      name: "平台 AI 编辑执行器",
      description: "平台内部功能",
      config: ARCHITECT_CONFIG,
    },
  ).catch((err) =>
    console.warn(
      "[owa] 初始化 AI 编辑执行器失败",
      err instanceof Error ? err.message : String(err),
    ),
  );
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
  // 审批钩子:本会话有同类授权就放行;否则推待审事件、挂起等裁决(见 approval/application/request-approval.ts)
  const requestApproval: NonNullable<EngineDeps["requestApproval"]> = (r, signal) =>
    requestApprovalWithGrants(
      {
        approval,
        publish: (sessionId, runId, e) => bus.publish(topicOf(sessionId, runId), e).then(() => {}),
        newId: () => randomUUID().replace(/-/g, "").slice(0, 24),
        now: () => Date.now(),
        timeoutMs: APPROVAL_TIMEOUT_MS,
      },
      r,
      signal,
    );
  const engine = createClaudeSdkEngine(
    env.dataDir,
    gateway,
    env.sandbox,
    env.allowStdioMcp,
    requestApproval,
  );

  // 运行中途追加消息:web 进程受理、worker 交给模型,经 Redis 交接(见 run/ports.ts 的 SteerChannel)
  const steerChannel = new RedisSteerChannel(env.redisUrl);
  const orchestrator = new RunOrchestrator({
    steerChannel,
    sessions,
    agents,
    engine,
    bus,
    platformCredentials: { baseUrl: env.defaultBaseUrl, key: env.defaultApiKey },
    // agent 子进程需要继承宿主环境(PATH 等),否则 Bash 里连 ls 都找不到。
    // 凭证与 HOME 会在 buildSdkOptions 里覆盖掉这里的同名项。
    baseEnv: inheritedEnv(),
    runAnchor: (runId) => runs.getResumeAnchor(runId),
    recordRunSession: (runId, sdkSessionId, range) =>
      runs.setSdkSessionId(runId, sdkSessionId, range),
    recordRunAnchor: (runId, anchor) => runs.setResumeAnchor(runId, anchor),
    // 与 GC 共用会话行锁:记下"刚用过"并确保目录存在(见 SessionRepo.prepareWorkspace)
    ensureWorkspace: (sessionId, dir) =>
      sessions.prepareWorkspace(sessionId, { nowMs: Date.now() }, async () => {
        await fs.mkdir(dir, { recursive: true });
      }),
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
  /** 账号的回调签名密钥。配置了却解不开就抛错 —— 不能退化成不签名照发。 */
  /** 账号的回调签名密钥(含换密钥重叠期内的旧密钥,见 signing-secrets.ts)。 */
  const webhookSecretOf = async (userId: string) => {
    const u = await users.get(userId);
    return u
      ? signingSecretsOf(u, (enc) => secrets.decrypt(enc), Date.now(), `user=${userId}`)
      : undefined;
  };
  /** 智能体当前的回调目标:地址 + 所有者的签名密钥。 */
  const webhookTargetOf = async (agentId: string) => {
    const agent = await agents.get(agentId);
    if (!agent?.webhookUrl) return null;
    const keys = await webhookSecretOf(agent.ownerId);
    return { agentId, url: agent.webhookUrl, ...(keys ?? {}) };
  };
  const webhookLog = new MysqlWebhookDeliveryLog(db);
  const webhooks = new WebhookDispatcher({
    outbox: runs,
    loadTarget: (job) =>
      resolveRunTarget(
        {
          session: (id) => sessions.get(id),
          agentTarget: webhookTargetOf,
          ownerSecret: async (agentId) => {
            // 已删除的智能体读不到:没有所有者可签名,抛错让这次投递判失败,而不是不签名照发
            const agent = await agents.get(agentId);
            if (!agent) throw new Error(`智能体不存在或已删除(agent=${agentId}),无法确定签名账号`);
            return webhookSecretOf(agent.ownerId);
          },
          userSecret: webhookSecretOf,
        },
        job,
      ),
    loadPayload: async (runId, sessionId) => {
      const r = await runs.getResult(runId);
      if (!r) return null;
      const session = await sessions.get(sessionId);
      // 与 /result、阻塞模式同一份结果契约,并附上工作目录的文件清单(产物)
      return {
        ...runFinishedPayload(r, { sessionId, agentId: session?.agentId }),
        ...(await taskFilesForResult(
          storage,
          session ? { sessionId, workspaceDir: session.workspaceDir } : null,
        )),
      };
    },
    deliver: (url, payload, secret, previousSecret) =>
      deliverWebhook(url, payload, { secret, previousSecret, maxAttempts: 2, send: webhookSender }),
    recordDelivery: (d) => webhookLog.record(d),
  });
  const webhookConsole = new WebhookConsole({
    targetOfAgent: webhookTargetOf,
    // 测试投递不做即时重试:一次的结果就是集成方要看的
    deliver: (url, payload, secret, previousSecret) =>
      deliverWebhook(url, payload, { secret, previousSecret, maxAttempts: 1, send: webhookSender }),
    log: webhookLog,
    outbox: runs,
  });

  // 评测:每个用例一个评测会话,按选定版本入队,与接口调用同一个运行内核
  const evals = new MysqlEvalRepo(db);
  const evalDeps: EvalDeps = {
    evals,
    agents,
    releases,
    sessions,
    workspaceFor: async (sessionId) => {
      const dir = workspacePathFor(env.dataDir, sessionId);
      await fs.mkdir(dir, { recursive: true });
      return dir;
    },
    enqueue: (r) => enqueuer.enqueue(r),
    results: runs,
    newId: () => randomUUID().replace(/-/g, "").slice(0, 24),
  };

  if (process.env.OWA_EMBEDDED_WORKER !== "0") {
    worker.start();
    webhooks.start();
  }

  // 工作空间 GC:定期两层回收,防磁盘无界增长。失败只记日志,绝不影响主流程。
  const gcLock = new RedisGcLock(env.redisUrl);
  const gc = new WorkspaceGc({
    workspacesRoot: path.join(env.dataDir, "workspaces"),
    listWorkspaces: () => runs.listSessionActivity(),
    reclaim: (id, opts, op) => sessions.reclaimWorkspace(id, opts, op),
    lockSession: (id, fn) => sessions.withWorkspaceLock(id, (st) => fn(st?.workspacePurgedAt)),
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
    probeDatabase,
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
    evals,
    evalDeps,
    worker,
    webhooks,
    webhookConsole,
    cancelSignal,
    steerChannel,
    rateLimiter,
    bundles: { read: readBundle, write: writeBundle },
    designer: new AgentDesigner({
      inSession: designTransaction(db),
      storage,
      allowStdioMcp: env.allowStdioMcp,
    }),
    capabilities: new MysqlCapabilityRepo(db),
    billing: new MysqlBillingRepo(db),
    packages: new MysqlPackageRepo(db),
    admission: new RunAdmission({
      sessions,
      checkQuota: async (userId) => {
        await assertWithinQuota({ users, usage }, userId);
      },
      checkRate: (i) =>
        checkInvokeRate(rateLimiter, {
          ...i,
          defaultKeyLimit: env.invokeRateLimitPerKey,
          agentLimit: env.invokeRateLimitPerAgent,
        }),
      inputSchemaOf: async (s) => {
        const agent = await agents.get(s.agentId);
        if (!agent) return undefined;
        return (await releases.at(agent, s.agentVersion)).config.inputSchema;
      },
      validateInput,
      quotaRejection: (err) =>
        err instanceof QuotaExceeded
          ? new AdmissionRejected(402, "quota_exceeded", err.message, {
              quota: {
                usedMicroUsd: err.verdict.usedMicroUsd,
                limitMicroUsd: err.verdict.limitMicroUsd,
              },
            })
          : null,
    }),
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
