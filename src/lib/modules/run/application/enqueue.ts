// 入队:所有发起运行的入口(网页对话、分支重跑、系统 invoke)共用这一处。
//
// 【为什么要收拢】入队曾经是各路由直接 runs.create:没有输入限长、不记配置快照、
// 请求级凭证覆盖在 invoke 里解析完就被丢掉。四个入口各自漏一点,
// 收拢到一处之后每条规则只需要写一次。

import type { AgentReleases } from "@/lib/modules/agent/application/releases";
import type { AgentConfig } from "@/lib/modules/agent/domain/config";
import type { AgentRepo } from "@/lib/modules/agent/ports";
import type { AdmitRequest } from "@/lib/modules/billing/application/run-charging";
import { checkPromptSize } from "@/lib/modules/run/domain/limits";
import {
  DuplicateIdempotencyKey,
  type NewRun,
  type Run,
  type RunRepo,
} from "@/lib/modules/run/ports";
import type { SessionRepo } from "@/lib/modules/session/ports";
import { BrandedError, type PinnedPricing } from "@/lib/shared";
import type { RunCommand } from "./orchestrator";

/** 输入超长。路由翻成 413。 */
export class PromptTooLarge extends BrandedError {
  static readonly brand = Symbol.for("owa.error.PromptTooLarge");
  constructor(message: string) {
    super(message);
    this.name = "PromptTooLarge";
  }
}

/** 会话或其智能体不存在。路由翻成 404。 */
export class EnqueueTargetMissing extends BrandedError {
  static readonly brand = Symbol.for("owa.error.EnqueueTargetMissing");
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
  /** 见 NewRun.resumeAt */
  resumeAt?: string;
  /** 请求级凭证覆盖。含明文 key,入库前加密。 */
  override?: RunCommand["override"];
  /**
   * 不投回调(评测里的运行):快照记为"无回调",之后智能体配上地址也不投。
   */
  noCallback?: boolean;
  /**
   * 调用方已经定好的配置快照(含版本号):直接用它,不再按会话读当前配置。
   * 评测用它保证一次评测的所有用例跑同一份配置 —— 否则评测过程中保存草稿,
   * 前几个用例跑 A、后几个跑 B,甚至按 A 的 inputSchema 校验却执行 B。
   */
  release?: { config: AgentConfig; version: number | null };
  /**
   * 调用方为这次指定的回调地址,入口已按回调地址策略校验过。
   * 不传则快照智能体此刻配置的默认地址(没配就记"无回调")。
   */
  callbackUrl?: string;
  /** 已带调用方作用域的幂等键。 */
  idempotencyKey?: string;
  idempotencyHash?: string;
}

/**
 * 计费受理与插入运行记录在同一事务里:先锁账户、算额度、冻结、写 run_charges,
 * 再插入运行 —— 任何一步失败(含幂等键重复)整体回滚,不会留下没有运行的冻结。
 */
export type ChargedCreate = <T>(
  fn: (scope: {
    runs: Pick<RunRepo, "create" | "findByIdempotencyKey">;
    /** 锁住账户(持有到事务结束):同一账户的受理在这里排队 */
    lockAccount: (accountId: string) => Promise<void>;
    admit: (req: AdmitRequest) => Promise<PinnedPricing>;
  }) => Promise<T>,
) => Promise<T>;

export interface EnqueueDeps {
  runs: Pick<RunRepo, "create">;
  /** 不给则不计费(单测、旧装配) */
  charged?: ChargedCreate;
  sessions: Pick<SessionRepo, "get">;
  agents: Pick<AgentRepo, "get">;
  /** 会话锁定了版本时按版本取配置快照。 */
  releases: Pick<AgentReleases, "at">;
  /** 加密请求级覆盖。不提供则拒绝带覆盖的请求 —— 绝不明文落库。 */
  encryptOverride?: (o: NonNullable<RunCommand["override"]>) => string;
}

/** 入口先调它:在建会话、建目录之前就拦住超长输入。 */
export function assertPromptSize(prompt: string): void {
  const v = checkPromptSize(prompt);
  if (!v.ok) throw new PromptTooLarge(v.reason);
}

function hasOverride(o: RunCommand["override"]): o is NonNullable<RunCommand["override"]> {
  return !!o?.model;
}

export class RunEnqueuer {
  constructor(private readonly deps: EnqueueDeps) {}

  async enqueue(req: EnqueueRequest): Promise<Run> {
    assertPromptSize(req.prompt);

    const session = await this.deps.sessions.get(req.sessionId);
    if (!session) throw new EnqueueTargetMissing(`session not found: ${req.sessionId}`);
    const agent = await this.deps.agents.get(session.agentId);
    if (!agent) throw new EnqueueTargetMissing(`agent not found: ${session.agentId}`);

    // 会话锁定了版本就跑那一版;版本不存在(不应发生)按目标缺失处理,而不是悄悄改跑草稿。
    // 调用方给了配置快照就用它
    const release =
      req.release ??
      (await this.deps.releases.at(agent, session.agentVersion).catch((err) => {
        throw new EnqueueTargetMissing(err instanceof Error ? err.message : String(err));
      }));

    let overrideEnc: string | undefined;
    if (hasOverride(req.override)) {
      if (!this.deps.encryptOverride) throw new Error("请求级凭证覆盖未启用加密,拒绝明文落库");
      overrideEnc = this.deps.encryptOverride(req.override);
    }

    const newRun = (pricing: PinnedPricing | null): NewRun => ({
      id: req.runId,
      sessionId: req.sessionId,
      prompt: req.prompt,
      parentRunId: req.parentRunId,
      resumeAnchor: req.resumeAnchor,
      resumeAt: req.resumeAt,
      agentConfig: release.config,
      agentVersion: release.version ?? undefined,
      overrideEnc,
      // 回调目标在受理时定下:之后改智能体的地址,不会把这次转投到新地址
      callback: req.noCallback
        ? { source: "none" }
        : req.callbackUrl
          ? { source: "caller", url: req.callbackUrl }
          : agent.webhookUrl
            ? { source: "agent", url: agent.webhookUrl }
            : { source: "none" },
      idempotencyKey: req.idempotencyKey,
      idempotencyHash: req.idempotencyHash,
      pricing,
    });

    // 花费记在会话的计费账号上;API Key 发起的会话同时计入那把 Key 的月度额度
    const accountId = session.billingUserId ?? session.ownerId;
    if (!this.deps.charged || !accountId) return this.deps.runs.create(newRun(null));
    return this.deps.charged(async ({ runs, lockAccount, admit }) => {
      // 同键并发:两个请求都过了入口的重放查询。后到的在账户锁上等先到的提交,
      // 拿到锁后先重查幂等键 —— 否则它会先撞上"额度只够一次"被拒(402),
      // 根本走不到插入时的重复键判断,调用方拿不回原任务
      if (req.idempotencyKey) {
        await lockAccount(accountId);
        if (await runs.findByIdempotencyKey(req.idempotencyKey)) {
          throw new DuplicateIdempotencyKey(req.idempotencyKey);
        }
      }
      const pricing = await admit({
        runId: req.runId,
        accountId,
        apiKeyId: session.callerApiKeyId ?? null,
        main: release.config.model,
        override: req.override?.model,
        subagents: release.config.subagents?.map((s) => ({ name: s.name, model: s.model })),
      });
      return runs.create(newRun(pricing));
    });
  }
}
