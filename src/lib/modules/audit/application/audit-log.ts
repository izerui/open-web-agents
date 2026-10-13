// 记一条审计:路由在操作成功【之后】调用。
//
// 【写失败不回滚业务操作】审计与业务写入不在同一个事务里(分属不同仓储)。审计写失败时
// 只记错误日志、请求照常返回 —— 业务已经生效,此时报错只会让调用方误以为没成功而重试。
// 代价:两次写入之间进程崩溃或审计库写失败,这条审计会丢。需要"有操作必有审计"的强保证,
// 得把审计改成与业务同库同事务的发件箱,目前没有这样做。
//
// 【整个记录过程有总等待上限】reject 能被 catch 住,但"数据库一直不返回"不会 reject ——
// 批准已生效、密码已改完,HTTP 却挂在查邮箱或 INSERT 上。所以查快照 + 写入整体限时,
// 超时同样按"尽力记录"处理:报告错误、让请求返回。
// 超时只表示【不再等】,底层的查询与写入并没有被取消,之后仍可能落库(或失败)。

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
  /** 写失败或超时时的报告方式(默认 console.error) */
  onError?: (err: unknown) => void;
  /** 一次记录(查快照 + 写入)的总等待上限,默认 1000ms */
  timeoutMs?: number;
}

/** 审计记录超时:只是不再等,底层写入未取消。 */
export class AuditTimeout extends Error {
  constructor(ms: number) {
    super(`审计记录超过 ${ms}ms 未完成,已放弃等待(底层写入未取消,之后仍可能落库)`);
    this.name = "AuditTimeout";
  }
}

const DEFAULT_TIMEOUT_MS = 1000;

export class AuditLog {
  constructor(private readonly deps: AuditLogDeps) {}

  /** 永不抛错,且有界返回(见文件头)。 */
  async record(input: AuditInput): Promise<void> {
    const ms = this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.write(input),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new AuditTimeout(ms)), ms);
        }),
      ]);
    } catch (err) {
      (this.deps.onError ?? ((e) => console.error("[audit] 写入失败", e)))(err);
    } finally {
      clearTimeout(timer);
    }
  }

  private async write(input: AuditInput): Promise<void> {
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
