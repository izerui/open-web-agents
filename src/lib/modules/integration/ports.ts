/**
 * 回调发件箱。运行落终态的同一条 UPDATE 里登记待投递,投递器按它补发。
 *
 * 【为什么要发件箱】回调曾经是进程内 fire-and-forget:进程在投递前崩溃或重启,
 * 这次回调就永久丢了,而等着它的企业系统不会知道。登记和终态写在同一条语句里,
 * "跑完了却没登记回调"就不可能发生。
 */
export interface WebhookOutbox {
  /** 认领一条到期的待投递回调,认领期间别的投递器拿不到它。attempts 含本次。 */
  claimWebhook(
    now: number,
    leaseMs: number,
  ): Promise<{ runId: string; sessionId: string; attempts: number } | null>;
  /** 记下结局;pending 表示稍后重试,nextAt 是下一次可投递的时刻。 */
  markWebhook(
    runId: string,
    state: "delivered" | "failed" | "skipped" | "pending",
    nextAt?: number,
  ): Promise<void>;
}
