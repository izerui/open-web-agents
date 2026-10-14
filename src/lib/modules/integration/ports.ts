/**
 * 回调发件箱。运行落终态的同一条 UPDATE 里登记待投递,投递器按它补发。
 *
 * 【为什么要发件箱】回调曾经是进程内 fire-and-forget:进程在投递前崩溃或重启,
 * 这次回调就永久丢了,而等着它的企业系统不会知道。登记和终态写在同一条语句里,
 * "跑完了却没登记回调"就不可能发生。
 */
/** 一条认领到的待投递回调。 */
export interface WebhookJob {
  runId: string;
  sessionId: string;
  /** 含本次 */
  attempts: number;
  /** 本次认领的令牌,写回结果时必须带上 */
  lease: string;
  /**
   * 受理时定下的回调目标:agent = 智能体当时的默认地址(所有者签名),
   * caller = 调用方指定的地址(调用方签名),none = 受理时没有回调。
   * 缺省 = 快照功能之前受理的旧任务,按投递时的配置投。
   */
  callback?: { source: "agent" | "caller"; url: string } | { source: "none" };
}

export interface WebhookOutbox {
  /**
   * 认领一条到期的待投递回调,认领期间别的投递器拿不到它。attempts 含本次。
   * lease 是本次认领的令牌,写回结果时必须带上。
   */
  claimWebhook(now: number, leaseMs: number): Promise<WebhookJob | null>;
  /**
   * 写回本次投递的结局;pending 表示稍后重试,nextAt 是下一次可投递的时刻。
   * 只有状态仍是 delivering 且令牌一致时才写入,返回是否写入 ——
   * 租约过期被别人接手、或已被手动重发,旧投递的结果一律丢弃。
   */
  markWebhook(
    runId: string,
    lease: string,
    state: "delivered" | "failed" | "skipped" | "pending",
    nextAt?: number,
  ): Promise<boolean>;
  /**
   * 手动重发:把一条已经结束的投递(delivered / failed / skipped)放回发件箱,立即可投,
   * 尝试次数清零(退避表重新开始)。还在待投 / 投递中的返回 false,不重复入队。
   */
  requeueWebhook(runId: string, now: number): Promise<boolean>;
}

/** 一次回调投递的记录(见 schema.webhookDeliveries)。 */
export interface WebhookDelivery {
  id: string;
  agentId: string;
  runId?: string;
  trigger: "auto" | "test";
  attempt?: number;
  /** 已脱敏:只有协议、主机、路径 */
  url: string;
  httpStatus?: number;
  ok: boolean;
  error?: string;
  durationMs: number;
  signed: boolean;
  at: number;
}

export interface WebhookDeliveryLog {
  record(d: WebhookDelivery): Promise<void>;
  /** 按时间倒序,键集分页 */
  listByAgent(
    agentId: string,
    q: { cursor?: string; limit?: number },
  ): Promise<{ items: WebhookDelivery[]; nextCursor?: string }>;
}
