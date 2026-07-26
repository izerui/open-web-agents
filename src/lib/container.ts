// Composition root:手工装配端口 → adapter。不用 DI 框架。
//
// 这是全工程唯一决定"用哪个实现"的地方 —— 换 DB / 换总线 / 换引擎都只改这里。

import { randomUUID } from "node:crypto";
import path from "node:path";
import { type Db, createDb } from "@/lib/db/client";
import { type Env, loadEnv } from "@/lib/env";
import { MysqlGrantRepo } from "@/lib/modules/access/adapters/mysql-grant-repo";
import { MysqlGroupRepo } from "@/lib/modules/access/adapters/mysql-group-repo";
import { Authorizer } from "@/lib/modules/access/application/authorize";
import { PUBLIC_PRINCIPAL } from "@/lib/modules/access/domain/grants";
import type { GroupRepo } from "@/lib/modules/access/group-ports";
import type { GrantRepo } from "@/lib/modules/access/ports";
import { createClaudeSdkEngine } from "@/lib/modules/agent-engine/adapters/claude-sdk/default-engine";
import type { EnginePort } from "@/lib/modules/agent-engine/ports";
import { RedisApproval } from "@/lib/modules/approval/adapters/redis-approval";
import type { ApprovalPort } from "@/lib/modules/approval/ports";
import { LocalFsStorage } from "@/lib/modules/artifacts/adapters/local-fs-storage";
import { WorkspaceGc } from "@/lib/modules/artifacts/application/gc";
import type { StoragePort } from "@/lib/modules/artifacts/ports";
import { MysqlAssistantRepo } from "@/lib/modules/assistant/adapters/mysql-assistant-repo";
import type { AssistantRepo } from "@/lib/modules/assistant/ports";
import { RedisBus } from "@/lib/modules/events/adapters/redis-bus";
import { ReplayBuffer } from "@/lib/modules/events/adapters/replay-buffer";
import type { BusPort } from "@/lib/modules/events/ports";
import { MysqlApiKeyRepo } from "@/lib/modules/identity/adapters/mysql-api-key-repo";
import { MysqlUserRepo } from "@/lib/modules/identity/adapters/mysql-user-repo";
import { AuthService } from "@/lib/modules/identity/application/auth-service";
import { SecretBox } from "@/lib/modules/identity/domain/secret-box";
import type { ApiKeyRepo } from "@/lib/modules/identity/ports";
import type { UserRepo } from "@/lib/modules/identity/user-ports";
import { deliverWebhook } from "@/lib/modules/integration/application/webhook";
import { MysqlKnowledgeRepo } from "@/lib/modules/knowledge/adapters/mysql-knowledge-repo";
import { formatContext, retrieve } from "@/lib/modules/knowledge/domain/retrieval";
import { EnvModelGateway } from "@/lib/modules/model-gateway/adapters/env-gateway";
import type { ModelGatewayPort } from "@/lib/modules/model-gateway/ports";
import { MysqlRunRepo } from "@/lib/modules/run/adapters/mysql-run-repo";
import { RunOrchestrator } from "@/lib/modules/run/application/orchestrator";
import { RunWorker } from "@/lib/modules/run/application/worker";
import { MysqlSessionRepo } from "@/lib/modules/session/adapters/mysql-session-repo";
import type { SessionRepo } from "@/lib/modules/session/ports";
import { MysqlUsageRepo } from "@/lib/modules/usage/adapters/mysql-usage-repo";

export interface Container {
  env: Env;
  db: Db;
  sessions: SessionRepo;
  assistants: AssistantRepo;
  bus: BusPort;
  engine: EnginePort;
  gateway: ModelGatewayPort;
  storage: StoragePort;
  approval: ApprovalPort;
  gc: WorkspaceGc;
  replay: ReplayBuffer;
  apiKeys: ApiKeyRepo;
  grants: GrantRepo;
  groups: GroupRepo;
  users: UserRepo;
  secrets: SecretBox;
  authService: AuthService;
  auth: Authorizer;
  runs: MysqlRunRepo;
  usage: MysqlUsageRepo;
  knowledge: MysqlKnowledgeRepo;
  orchestrator: RunOrchestrator;
  worker: RunWorker;
}

/** 人工审批的等待上限。到点自动拒绝,避免 worker 被无人值守的审批永久占住。 */
const APPROVAL_TIMEOUT_MS = 10 * 60_000;

/**
 * 内置的通用助手:未定义 outputSchema,故只回对话文本(设计文档 §3)。
 * 助手构建器接入后改为从库里读。
 */
const DEFAULT_ASSISTANT = {
  id: "default",
  // 平台内置,归 system 所有;通过公开授权让所有人可用(见 build())
  ownerId: "system",
  name: "通用助手",
  description: "可对话、可用工具在会话工作目录里干活的通用助手",
  config: {
    systemPrompt: [
      "你是 Open Web Agents 平台上的通用助手。",
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
  const assistants = new MysqlAssistantRepo(db);
  // 首次启动播种内置助手,保证开箱可用;已存在则覆盖为最新定义。
  // 它归 system 所有,故必须同时授予公开 read —— 否则新注册用户在列表里看不到它。
  void assistants
    .upsert(DEFAULT_ASSISTANT)
    .then(() =>
      grants.grant({
        id: "grant-default-public",
        resourceType: "assistant",
        resourceId: DEFAULT_ASSISTANT.id,
        principalType: "*",
        principalId: PUBLIC_PRINCIPAL,
        permission: "read",
      }),
    )
    .catch(() => {});
  const bus = new RedisBus(env.redisUrl);
  const runs = new MysqlRunRepo(db);
  const storage = new LocalFsStorage();
  const approval = new RedisApproval(env.redisUrl);
  const usage = new MysqlUsageRepo(db);
  const knowledge = new MysqlKnowledgeRepo(db);
  const replay = new ReplayBuffer();
  const apiKeys = new MysqlApiKeyRepo(db);
  const grants = new MysqlGrantRepo(db);
  const groupRepo = new MysqlGroupRepo(db);
  const users = new MysqlUserRepo(db);
  const secrets = new SecretBox(env.secretKey);
  const authService = new AuthService({
    users,
    sessionSecret: env.sessionSecret,
    secureCookie: process.env.NODE_ENV === "production",
  });
  const auth = new Authorizer({
    apiKeys,
    sessions,
    authRequired: env.authRequired,
    currentUser: (req) => authService.currentUser(req),
    groupIdsOf: (userId) => groupRepo.groupIdsOf(userId),
  });
  // 审批钩子:先把待审事件推上总线(界面才看得到),再挂起等裁决。
  // 超时兜底在 RedisApproval 里 —— 没人审批时到点自动拒,绝不永久占住 worker。
  const engine = createClaudeSdkEngine(env.dataDir, gateway, env.sandbox, async (r) => {
    const id = randomUUID().replace(/-/g, "").slice(0, 24);
    const expiresAt = Date.now() + APPROVAL_TIMEOUT_MS;

    await bus
      .publish(`session:${r.sessionId}`, {
        kind: "status",
        label: `待审批:${r.toolName} — ${r.summary}(${r.reason})`,
        state: "awaiting_approval",
      })
      .catch(() => {});

    const outcome = await approval.request({
      id,
      sessionId: r.sessionId,
      runId: r.runId,
      toolName: r.toolName,
      summary: r.summary,
      reason: r.reason,
      createdAt: Date.now(),
      expiresAt,
    });

    const label =
      outcome.decision === "approved"
        ? `审批通过:${r.toolName}`
        : outcome.decision === "expired"
          ? `审批超时自动拒绝:${r.toolName}`
          : `审批被拒:${r.toolName}`;
    await bus
      .publish(`session:${r.sessionId}`, { kind: "status", label, state: outcome.decision })
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
  });

  const orchestrator = new RunOrchestrator({
    sessions,
    assistants,
    engine,
    bus,
    platformCredentials: { baseUrl: env.defaultBaseUrl, key: env.defaultApiKey },
    // agent 子进程需要继承宿主环境(PATH 等),否则 Bash 里连 ls 都找不到。
    // 凭证与 HOME 会在 buildSdkOptions 里覆盖掉这里的同名项。
    baseEnv: inheritedEnv(),
    replay,
    runAnchor: (runId) => runs.getResumeAnchor(runId),
    recordRunSession: (runId, sdkSessionId) => runs.setSdkSessionId(runId, sdkSessionId),
    recordRunAnchor: (runId, anchor) => runs.setResumeAnchor(runId, anchor),
    // 知识检索:没有文档或没命中都返回空串,上层据此决定不注入
    retrieveKnowledge: async (assistantId, query) => {
      const chunks = await knowledge.chunksOf(assistantId);
      if (chunks.length === 0) return "";
      return formatContext(retrieve(query, chunks));
    },
    // 每用户自带凭证:运行时才解密,解不开(换过主密钥)就当未配置、回落平台默认
    userCredentials: async (userId) => {
      const u = await users.get(userId);
      if (!u) return {};
      const key = u.anthropicKeyEnc ? secrets.decrypt(u.anthropicKeyEnc) : null;
      return { baseUrl: u.defaultBaseUrl, key: key ?? undefined };
    },
    // 助手配了 webhookUrl 就在终态推一次;失败不影响 run 状态(可轮询兜底)
    onComplete: ({ runId, assistantId, result }) => {
      void (async () => {
        const a = await assistants.get(assistantId);
        const url = a?.webhookUrl;
        if (!url || !runId) return;
        await deliverWebhook(url, {
          taskId: runId,
          status: result.status,
          structured: result.structured,
          summary: result.summary,
          error: result.error,
        }).catch(() => {});
      })();
    },
  });

  // 同进程内起 worker;拆成独立进程只需把这段挪到单独入口,代码不变(worker 无本地状态)。
  const worker = new RunWorker(runs, orchestrator);
  worker.start();

  // 工作空间 GC:定期两层回收,防磁盘无界增长。失败只记日志,绝不影响主流程。
  const gc = new WorkspaceGc({
    workspacesRoot: path.join(env.dataDir, "workspaces"),
    listWorkspaces: () => runs.listSessionActivity(),
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
    db,
    sessions,
    assistants,
    bus,
    engine,
    gateway,
    storage,
    approval,
    gc,
    replay,
    apiKeys,
    grants,
    groups: groupRepo,
    users,
    secrets,
    authService,
    auth,
    runs,
    usage,
    knowledge,
    orchestrator,
    worker,
  };
}

// dev 下 Next 会热重载模块,挂到 globalThis 上避免连接池与 worker 被重复创建
const g = globalThis as { __owaContainer?: Container };

export function getContainer(): Container {
  g.__owaContainer ??= build();
  return g.__owaContainer;
}
