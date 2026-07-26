// Composition root:手工装配端口 → adapter。不用 DI 框架。
//
// 这是全工程唯一决定"用哪个实现"的地方 —— 换 DB / 换总线 / 换引擎都只改这里。

import { type Db, createDb } from "@/lib/db/client";
import { type Env, loadEnv } from "@/lib/env";
import { createClaudeSdkEngine } from "@/lib/modules/agent-engine/adapters/claude-sdk/default-engine";
import type { EnginePort } from "@/lib/modules/agent-engine/ports";
import { InMemoryAssistantRepo } from "@/lib/modules/assistant/adapters/in-memory-assistant-repo";
import type { AssistantRepo } from "@/lib/modules/assistant/ports";
import { RedisBus } from "@/lib/modules/events/adapters/redis-bus";
import type { BusPort } from "@/lib/modules/events/ports";
import { EnvModelGateway } from "@/lib/modules/model-gateway/adapters/env-gateway";
import type { ModelGatewayPort } from "@/lib/modules/model-gateway/ports";
import { MysqlRunRepo } from "@/lib/modules/run/adapters/mysql-run-repo";
import { RunOrchestrator } from "@/lib/modules/run/application/orchestrator";
import { RunWorker } from "@/lib/modules/run/application/worker";
import { MysqlSessionRepo } from "@/lib/modules/session/adapters/mysql-session-repo";
import type { SessionRepo } from "@/lib/modules/session/ports";

export interface Container {
  env: Env;
  db: Db;
  sessions: SessionRepo;
  assistants: AssistantRepo;
  bus: BusPort;
  engine: EnginePort;
  gateway: ModelGatewayPort;
  runs: MysqlRunRepo;
  orchestrator: RunOrchestrator;
  worker: RunWorker;
}

/**
 * 内置的通用助手:未定义 outputSchema,故只回对话文本(设计文档 §3)。
 * 助手构建器接入后改为从库里读。
 */
const DEFAULT_ASSISTANT = {
  id: "default",
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
  const assistants = new InMemoryAssistantRepo([DEFAULT_ASSISTANT]);
  const bus = new RedisBus(env.redisUrl);
  const runs = new MysqlRunRepo(db);
  const engine = createClaudeSdkEngine(env.dataDir, gateway);

  const orchestrator = new RunOrchestrator({
    sessions,
    assistants,
    engine,
    bus,
    platformCredentials: { baseUrl: env.defaultBaseUrl, key: env.defaultApiKey },
    // agent 子进程需要继承宿主环境(PATH 等),否则 Bash 里连 ls 都找不到。
    // 凭证与 HOME 会在 buildSdkOptions 里覆盖掉这里的同名项。
    baseEnv: inheritedEnv(),
  });

  // 同进程内起 worker;拆成独立进程只需把这段挪到单独入口,代码不变(worker 无本地状态)。
  const worker = new RunWorker(runs, orchestrator);
  worker.start();

  return { env, db, sessions, assistants, bus, engine, gateway, runs, orchestrator, worker };
}

// dev 下 Next 会热重载模块,挂到 globalThis 上避免连接池与 worker 被重复创建
const g = globalThis as { __owaContainer?: Container };

export function getContainer(): Container {
  g.__owaContainer ??= build();
  return g.__owaContainer;
}
