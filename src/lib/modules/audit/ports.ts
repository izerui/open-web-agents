import type { AuditAction } from "@/lib/modules/audit/domain/events";

export type AuditActorType = "user" | "apiKey" | "anonymous";

/** 一条审计记录。只追加,不修改、不删除。 */
export interface AuditEvent {
  id: string;
  /** 发生时刻(ms) */
  at: number;
  actor: {
    type: AuditActorType;
    /** 用户 id 或 Key id;匿名(如登录失败)为空 */
    id?: string;
    /** 写入时的可读快照(邮箱、Key 名称):账号改名、Key 吊销后仍看得懂 */
    label?: string;
  };
  action: AuditAction;
  resource: { type: string; id?: string };
  /**
   * 资源归属账号。决定谁能看到这条记录:归属人与操作者本人都能看,管理员看全部。
   * 例如别人改了你分享出去的智能体、有人试图登录你的账号 —— 你都应该看得到。
   */
  ownerId?: string;
  /** 已脱敏的细节(见 domain/events.ts 的 sanitizeDetails) */
  details?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}

export interface AuditFilter {
  /** 只看与该用户相关的:他是归属人或操作者。不传 = 全部(仅管理员) */
  visibleTo?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  since?: number;
  until?: number;
  cursor?: string;
  /** 默认 50,上限 200 */
  limit?: number;
}

export interface AuditRepo {
  /** 只追加。同一 id 已存在时忽略(去重键生成的 id 靠它实现"只记一条") */
  append(e: AuditEvent): Promise<void>;
  /** 按时间倒序,键集分页 */
  list(f: AuditFilter): Promise<{ items: AuditEvent[]; nextCursor?: string }>;
}
