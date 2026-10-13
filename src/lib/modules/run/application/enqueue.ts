// 入队:所有发起运行的入口(网页对话、分支重跑、系统 invoke、embed)共用这一处。
//
// 【为什么要收拢】入队曾经是各路由直接 runs.create:没有输入限长、不记配置快照、
// 请求级凭证覆盖在 invoke 里解析完就被丢掉。四个入口各自漏一点,
// 收拢到一处之后每条规则只需要写一次。

import type { AgentRepo } from "@/lib/modules/agent/ports";
import { checkPromptSize } from "@/lib/modules/run/domain/limits";
import type { Run, RunRepo } from "@/lib/modules/run/ports";
import type { SessionRepo } from "@/lib/modules/session/ports";
import type { RunCommand } from "./orchestrator";

/** 输入超长。路由翻成 413。 */
export class PromptTooLarge extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptTooLarge";
  }
}

/** 会话或其智能体不存在。路由翻成 404。 */
export class EnqueueTargetMissing extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnqueueTargetMissing";
  }
}

export interface EnqueueRequest {
  runId: string;
  sessionId: string;
  prompt: string;
  parentRunId?: string;
  resumeAnchor?: string;
  /** 请求级凭证覆盖。含明文 key,入库前加密。 */
  override?: RunCommand["override"];
  /** 已带调用方作用域的幂等键。 */
  idempotencyKey?: string;
  idempotencyHash?: string;
}

export interface EnqueueDeps {
  runs: Pick<RunRepo, "create">;
  sessions: Pick<SessionRepo, "get">;
  agents: Pick<AgentRepo, "get">;
  /** 加密请求级覆盖。不提供则拒绝带覆盖的请求 —— 绝不明文落库。 */
  encryptOverride?: (o: NonNullable<RunCommand["override"]>) => string;
}

/** 入口先调它:在建会话、建目录之前就拦住超长输入。 */
export function assertPromptSize(prompt: string): void {
  const v = checkPromptSize(prompt);
  if (!v.ok) throw new PromptTooLarge(v.reason);
}

function hasOverride(o: RunCommand["override"]): o is NonNullable<RunCommand["override"]> {
  return !!o && (!!o.baseUrl || !!o.key || !!o.model);
}

export class RunEnqueuer {
  constructor(private readonly deps: EnqueueDeps) {}

  async enqueue(req: EnqueueRequest): Promise<Run> {
    assertPromptSize(req.prompt);

    const session = await this.deps.sessions.get(req.sessionId);
    if (!session) throw new EnqueueTargetMissing(`session not found: ${req.sessionId}`);
    const agent = await this.deps.agents.get(session.agentId);
    if (!agent) throw new EnqueueTargetMissing(`agent not found: ${session.agentId}`);

    let overrideEnc: string | undefined;
    if (hasOverride(req.override)) {
      if (!this.deps.encryptOverride) throw new Error("请求级凭证覆盖未启用加密,拒绝明文落库");
      overrideEnc = this.deps.encryptOverride(req.override);
    }

    return this.deps.runs.create({
      id: req.runId,
      sessionId: req.sessionId,
      prompt: req.prompt,
      parentRunId: req.parentRunId,
      resumeAnchor: req.resumeAnchor,
      agentConfig: agent.config,
      overrideEnc,
      idempotencyKey: req.idempotencyKey,
      idempotencyHash: req.idempotencyHash,
    });
  }
}
