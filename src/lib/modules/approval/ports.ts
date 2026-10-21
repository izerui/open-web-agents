import { type AskedQuestion, BrandedError } from "@/lib/shared";

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  runId?: string;
  toolName: string;
  /** 给审批人看的摘要(已截断)。 */
  summary: string;
  reason: string;
  /**
   * 这次调用所属的全部类别;审批人可以把这些类授权给本会话(见 SessionGrant)。
   * 之后只有每一类都已授权才自动放行。规则没给就没有。
   */
  scopes?: { key: string; label: string }[];
  /**
   * 有这项就不是审批,而是智能体在问用户(AskUserQuestion):界面在对话里的提问卡片上作答,
   * 裁决带回答案。toolUseId 用来把这条待回答和对话里的那张卡片对上
   */
  questions?: AskedQuestion[];
  toolUseId?: string;
  createdAt: number;
  /** 到点自动拒绝的时刻。 */
  expiresAt: number;
}

/**
 * 会话级授权:审批人批准时选了"本会话内同类不再询问"。之后同一会话里同一类调用直接放行。
 * 只在会话内有效,可随时撤销。
 */
export interface SessionGrant {
  key: string;
  label: string;
  /** 谁授权的 */
  by?: string;
  at: number;
}

export type ApprovalOutcome =
  /** answers:提问的回答,键是问题原文,值是选中的选项或自己填写的内容(多个用"、"连接) */
  | { decision: "approved"; by?: string; answers?: Record<string, string> }
  | { decision: "denied"; by?: string; message?: string }
  | { decision: "expired" };

/**
 * 审批基础设施不可用:无法登记待审,或到期时无法确认是否已有裁决。
 *
 * 【为什么不能当成 expired】expired 是业务结论("没人批");这里是"不知道有没有人批"。
 * 批准可能早已落地,只是读不到 —— 冒充成超时拒绝,审计上就成了"审批人批准了,系统说没人批"。
 * 调用方应按基础设施故障处理(引擎侧按 fail-closed 拒绝本次工具调用,并如实说明原因)。
 */
export class ApprovalUnavailable extends BrandedError {
  static readonly brand = Symbol.for("owa.error.ApprovalUnavailable");
  constructor(message: string) {
    super(message);
    this.name = "ApprovalUnavailable";
  }
}

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
  /**
   * 【必须】有界结束:基础设施不可用时以 ApprovalUnavailable 失败,而不是无限等待。
   */
  request(req: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalOutcome>;
  /**
   * 裁决一条待审请求。返回是否命中(已过期/不存在则 false)。
   * 裁决落地即返回 true,不等广播;落地本身无法确认时以 ApprovalUnavailable 有界失败。
   */
  resolve(
    id: string,
    outcome: ApprovalOutcome,
    /** 批准并记下本会话的同类授权:与裁决原子落地 —— 裁决没生效,授权也不会写入 */
    remember?: { sessionId: string; grants: SessionGrant[] },
  ): Promise<boolean>;
  /** 本会话的同类授权。不可用时以 ApprovalUnavailable 有界失败。 */
  grants(sessionId: string): Promise<SessionGrant[]>;
  /** 撤销一条同类授权,返回是否存在。 */
  revokeGrant(sessionId: string, key: string): Promise<boolean>;
  /** 列出某会话的待审请求,供界面展示。基础设施不可用时以 ApprovalUnavailable 有界失败。 */
  listPending(sessionId: string): Promise<ApprovalRequest[]>;
}
