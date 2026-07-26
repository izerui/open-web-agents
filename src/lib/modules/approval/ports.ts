export interface ApprovalRequest {
  id: string;
  sessionId: string;
  runId?: string;
  toolName: string;
  /** 给审批人看的摘要(已截断)。 */
  summary: string;
  reason: string;
  createdAt: number;
  /** 到点自动拒绝的时刻。 */
  expiresAt: number;
}

export type ApprovalOutcome =
  | { decision: "approved"; by?: string }
  | { decision: "denied"; by?: string; message?: string }
  | { decision: "expired" };

/**
 * 人工审批端口。
 *
 * 跨进程是硬要求:agent 跑在 worker 里,裁决来自 web 请求 ——
 * 单进程内存实现只在同进程部署下成立,多实例必须用 Redis(见 adapters)。
 */
export interface ApprovalPort {
  /**
   * 发起审批并等待裁决。
   *
   * 【必须】在 expiresAt 到点后返回 expired —— 没人审批时若无限等待,
   * worker 会被永久占住(这个坑在 run 超时那次已经踩过一次)。
   *
   * 【必须】响应 signal:运行被取消或超时中止时,这条待审请求要立刻收场。
   * 曾经没有这个参数,等待只由自己的 10 分钟定时器驱动,于是运行早已结束,而
   * waiter、定时器、Redis 里的 pending key 全都还在 —— worker 进程内按
   * 「被中止的运行数 × 10 分钟」持续累积;更糟的是界面上那条待审请求照常显示,
   * 用户点批准还能拿到 200「已裁决」,等于为一个不存在的运行授权了危险操作。
   */
  request(req: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalOutcome>;
  /** 裁决一条待审请求。返回是否命中(已过期/不存在则 false)。 */
  resolve(id: string, outcome: ApprovalOutcome): Promise<boolean>;
  /** 列出某会话的待审请求,供界面展示。 */
  listPending(sessionId: string): Promise<ApprovalRequest[]>;
}
