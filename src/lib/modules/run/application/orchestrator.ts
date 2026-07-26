// 运行编排(Application 层):人用对话与系统 invoke 共用的【同一个运行内核】。
// 只依赖端口接口,不碰框架与 IO 细节 —— 用内存 fake 即可完整单测。

import {
  resolveCredentials,
  resolveModelAlias,
} from "@/lib/modules/agent-engine/domain/resolve-credentials";
import type { EnginePort, RunResult } from "@/lib/modules/agent-engine/ports";
import { buildSpec } from "@/lib/modules/assistant/domain/build-spec";
import type { AssistantRepo } from "@/lib/modules/assistant/ports";
import type { BusPort } from "@/lib/modules/events/ports";
import type { SessionRepo } from "@/lib/modules/session/ports";
import type { AgentEvent, CredentialChain, ModelAlias } from "@/lib/shared";

/** 一次运行请求。人用对话与系统 invoke 都收敛成这一个 Command。 */
export interface RunCommand {
  sessionId: string;
  prompt: string;
  /** 队列里的 run id(worker 执行时带上;内联执行可不传)。 */
  runId?: string;
  /** 请求级覆盖(三级链最高优先)。 */
  override?: { baseUrl?: string; key?: string; model?: ModelAlias };
}

export interface OrchestratorDeps {
  sessions: SessionRepo;
  assistants: AssistantRepo;
  engine: EnginePort;
  bus: BusPort;
  /** 平台默认凭证(三级链兜底)。 */
  platformCredentials: { baseUrl: string; key: string };
  /** 传给 agent 子进程的基础环境。 */
  baseEnv?: Record<string, string>;
}

/** 事件总线上的 topic:按会话隔离。 */
export function topicOf(sessionId: string): string {
  return `session:${sessionId}`;
}

export class RunOrchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  /**
   * 执行一轮:解析凭证 → 组装 spec → 跑引擎 → 事件全程上总线 → 记 sdkSessionId 供下轮 resume。
   * 事件在产生的同时发布,订阅者(SSE)实时可见。
   */
  async execute(cmd: RunCommand, signal: AbortSignal): Promise<RunResult> {
    const session = await this.deps.sessions.get(cmd.sessionId);
    if (!session) throw new Error(`session not found: ${cmd.sessionId}`);

    const assistant = await this.deps.assistants.get(session.assistantId);
    if (!assistant) throw new Error(`assistant not found: ${session.assistantId}`);

    const chain: CredentialChain = {
      platform: this.deps.platformCredentials,
      session: { baseUrl: session.baseUrl, key: session.key, model: session.model },
      request: cmd.override,
    };
    const credentials = resolveCredentials(chain);
    const model = resolveModelAlias(chain, assistant.config.model);

    const ctx = {
      workspaceDir: session.workspaceDir,
      prompt: cmd.prompt,
      resumeSessionId: session.sdkSessionId,
      credentials,
      env: this.deps.baseEnv ?? {},
    };
    const spec = buildSpec(assistant.config, ctx, { model });

    const topic = topicOf(cmd.sessionId);
    const publish = (e: AgentEvent) => {
      // 事件投递失败不应中断 agent 运行
      void this.deps.bus.publish(topic, e).catch(() => {});
    };

    publish({ kind: "status", label: "运行中", state: "running" });

    const result = await this.deps.engine.run(spec, ctx, publish, signal);

    if (result.sessionId) {
      await this.deps.sessions.setSdkSessionId(cmd.sessionId, result.sessionId);
    }

    publish({
      kind: "result",
      status: result.status,
      structured: result.structured,
      summary: result.summary ?? result.error?.message,
    });

    return result;
  }
}
