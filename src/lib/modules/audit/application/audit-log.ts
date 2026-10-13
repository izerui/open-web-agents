// 记一条审计:路由在操作成功【之后】调用。
//
// 【写失败不回滚业务操作】审计与业务写入不在同一个事务里(分属不同仓储)。审计写失败时
// 只记错误日志、请求照常返回 —— 业务已经生效,此时报错只会让调用方误以为没成功而重试。
// 代价:两次写入之间进程崩溃或审计库写失败,这条审计会丢。需要"有操作必有审计"的强保证,
// 得把审计改成与业务同库同事务的发件箱,目前没有这样做。

import { randomUUID } from "node:crypto";
import { type AuditAction, sanitizeDetails } from "@/lib/modules/audit/domain/events";
import type { AuditActorType, AuditRepo } from "@/lib/modules/audit/ports";

/** 操作者:与访问控制的 Principal 同形,再加一个"匿名"(登录失败时还不知道是谁)。 */
export type AuditActor =
  | { type: "web"; userId: string }
  | { type: "apiKey"; keyId: string; ownerId: string }
  | { type: "anonymous" };

export interface AuditInput {
  actor: AuditActor;
  action: AuditAction;
  resource: { type: string; id?: string };
  /** 资源归属账号(决定谁能看到这条记录) */
  ownerId?: string;
  details?: Record<string, unknown>;
  /** 用来取来源地址与 User-Agent */
  req?: Request;
}

export interface AuditLogDeps {
  repo: AuditRepo;
  /** 取账号邮箱作为可读快照;取不到就只记 id */
  emailOf?: (userId: string) => Promise<string | undefined>;
  now?: () => number;
  /** 写失败时的报告方式(默认 console.error) */
  onError?: (err: unknown) => void;
}

export class AuditLog {
  constructor(private readonly deps: AuditLogDeps) {}

  /** 永不抛错(见文件头)。 */
  async record(input: AuditInput): Promise<void> {
    try {
      const actor = await this.actorOf(input.actor);
      await this.deps.repo.append({
        id: randomUUID(),
        at: (this.deps.now ?? Date.now)(),
        actor,
        action: input.action,
        resource: input.resource,
        ownerId: input.ownerId,
        details: input.details
          ? (sanitizeDetails(input.details) as Record<string, unknown>)
          : undefined,
        ip: input.req ? clientIp(input.req) : undefined,
        userAgent: input.req?.headers.get("user-agent") ?? undefined,
      });
    } catch (err) {
      (this.deps.onError ?? ((e) => console.error("[audit] 写入失败", e)))(err);
    }
  }

  list(...args: Parameters<AuditRepo["list"]>) {
    return this.deps.repo.list(...args);
  }

  private async actorOf(
    a: AuditActor,
  ): Promise<{ type: AuditActorType; id?: string; label?: string }> {
    if (a.type === "anonymous") return { type: "anonymous" };
    if (a.type === "apiKey") {
      const owner = await this.deps.emailOf?.(a.ownerId).catch(() => undefined);
      return { type: "apiKey", id: a.keyId, label: owner ? `Key(${owner})` : undefined };
    }
    return {
      type: "user",
      id: a.userId,
      label: await this.deps.emailOf?.(a.userId).catch(() => undefined),
    };
  }
}

/** 反向代理后取 X-Forwarded-For 的第一段。只作记录,不用于鉴权。 */
function clientIp(req: Request): string | undefined {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    undefined
  );
}
