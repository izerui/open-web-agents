// 运行编排(Application 层):人用对话与系统 invoke 共用的【同一个运行内核】。
// 只依赖端口接口,不碰框架与 IO 细节 —— 用内存 fake 即可完整单测。

import {
  resolveCredentials,
  resolveModelAlias,
} from "@/lib/modules/agent-engine/domain/resolve-credentials";
import type { EnginePort, RunResult } from "@/lib/modules/agent-engine/ports";
import { buildSpec } from "@/lib/modules/assistant/domain/build-spec";
import { validateStructured } from "@/lib/modules/assistant/domain/validate-output";
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
  /** 记录事件供断线重连回放(可选)。 */
  replay?: { record(topic: string, e: AgentEvent): void; reset(topic: string): void };
  /**
   * 解析会话归属用户的自带凭证(三级链里的 user 层)。
   * 返回已解密的明文;没配置则返回空对象。
   */
  userCredentials?: (userId: string) => Promise<{ baseUrl?: string; key?: string }>;
  /**
   * 取该运行自带的 resume 锚点(分支重跑用)。
   * anchored=true 时【必须】用它给出的锚点 —— 包括"从零重开"的空锚点;
   * 否则回退到会话最新锚点,分支就会串回主线。
   */
  runAnchor?: (runId: string) => Promise<{ anchored: boolean; anchor?: string }>;
  /** 记录本轮产生的 SDK 会话到该运行上,供后续分支续接。 */
  recordRunSession?: (runId: string, sdkSessionId: string) => Promise<void>;
  /** 记录本轮实际使用的起跑锚点,供审计。 */
  recordRunAnchor?: (runId: string, anchor: string | null) => Promise<void>;
  /**
   * 按本轮输入检索助手知识库,返回可直接注入提示词的文本(无命中则空串)。
   * 检索失败不该让整轮运行失败 —— 降级成"没有知识库"继续跑。
   */
  retrieveKnowledge?: (assistantId: string, query: string) => Promise<string>;
  /** 终态时投递 webhook(可选)。 */
  onComplete?: (info: {
    runId?: string;
    sessionId: string;
    assistantId: string;
    result: RunResult;
  }) => void;
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

    // 三级链的 user 层:会话归属用户自带的 base_url/key(设计文稿 §9)
    const userCreds = session.ownerId
      ? await this.deps.userCredentials?.(session.ownerId).catch(() => undefined)
      : undefined;

    const chain: CredentialChain = {
      platform: this.deps.platformCredentials,
      user: userCreds,
      session: { baseUrl: session.baseUrl, key: session.key, model: session.model },
      request: cmd.override,
    };
    const credentials = resolveCredentials(chain);
    const model = resolveModelAlias(chain, assistant.config.model);

    // 分支重跑:优先用该运行自己的锚点。只有它没有明确意图时才回退到会话最新状态
    let resumeSessionId = session.sdkSessionId;
    if (cmd.runId && this.deps.runAnchor) {
      const a = await this.deps
        .runAnchor(cmd.runId)
        .catch((): { anchored: boolean; anchor?: string } => ({ anchored: false }));
      if (a.anchored) resumeSessionId = a.anchor;
    }

    // 如实记下这一轮到底从哪儿起跑 —— 事后排查"为什么它记得/不记得某件事"全靠它
    if (cmd.runId) {
      await this.deps.recordRunAnchor?.(cmd.runId, resumeSessionId ?? null).catch(() => {});
    }

    const ctx = {
      sessionId: cmd.sessionId,
      runId: cmd.runId,
      workspaceDir: session.workspaceDir,
      prompt: cmd.prompt,
      resumeSessionId,
      credentials,
      env: this.deps.baseEnv ?? {},
    };
    // 知识检索:命中才注入。检索挂了就当没有知识库,不牵连整轮运行
    const knowledgeContext = this.deps.retrieveKnowledge
      ? await this.deps.retrieveKnowledge(session.assistantId, cmd.prompt).catch(() => "")
      : "";

    const spec = buildSpec(assistant.config, ctx, { model, knowledgeContext });

    const topic = topicOf(cmd.sessionId);
    // 事件投递是【辅助能力】:发不出去只是看不到过程,绝不该让用户的这一轮运行失败。
    // 重放缓冲同理 —— 当前内存实现不会抛,但换成 Redis 支撑的实现后一定会。
    const publish = (e: AgentEvent) => {
      try {
        this.deps.replay?.record(topic, e);
      } catch {
        // 缓冲写入失败只影响断线重连的回放质量,不影响本次运行
      }
      void this.deps.bus.publish(topic, e).catch(() => {});
    };

    // 新一轮开始清空重放缓冲,免得把上一轮的事件回放给这一轮
    try {
      this.deps.replay?.reset(topic);
    } catch {
      // 同上:缓冲故障不牵连运行
    }
    publish({ kind: "status", label: "运行中", state: "running" });
    // 让用户看得到"这次回答参考了知识库",而不是凭空多出一些内容
    if (knowledgeContext) {
      publish({ kind: "status", label: "已引用知识库资料", state: "knowledge" });
    }

    let result = await this.deps.engine.run(spec, ctx, publish, signal);

    if (result.sessionId) {
      // 会话的"当前位置"跟着最新一次运行走
      await this.deps.sessions.setSdkSessionId(cmd.sessionId, result.sessionId);
      // 同时记到本次运行上 —— 将来要从这一轮分叉时需要它
      if (cmd.runId) {
        await this.deps.recordRunSession?.(cmd.runId, result.sessionId).catch(() => {});
      }
    }

    // 接口契约守门:声明了 outputSchema 就必须真的符合它,否则调用方会拿到"半对"的结果
    if (result.status === "success" && spec.outputSchema) {
      const verdict = validateStructured(spec.outputSchema, result.structured);
      if (!verdict.ok) {
        result = {
          ...result,
          status: "failed",
          error: {
            kind: "schema_mismatch",
            message: `结构化结果不符 outputSchema: ${verdict.errors?.join("; ")}`,
          },
        };
      }
    }

    publish({
      kind: "result",
      status: result.status,
      structured: result.structured,
      summary: result.summary ?? result.error?.message,
    });

    // 终态回调(webhook 等)。失败不影响 run 的最终状态 —— 结果已在库里,可轮询兜底
    try {
      this.deps.onComplete?.({
        runId: cmd.runId,
        sessionId: cmd.sessionId,
        assistantId: session.assistantId,
        result,
      });
    } catch {
      // 回调注册方自己的问题,不牵连运行
    }

    return result;
  }
}
