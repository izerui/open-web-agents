// 把 HTTP 请求解析成调用主体,并对资源做授权判定。
// route handler 只调这里,不自己拼授权逻辑 —— 规则集中一处才不会漏。

import {
  type Decision,
  type Principal,
  canAccessSession,
  canInvokeAssistant,
  canManageAssistants,
} from "@/lib/modules/access/domain/principal";
import { extractApiKey, hashApiKey, looksLikeApiKey } from "@/lib/modules/identity/domain/api-key";
import type { ApiKeyRepo } from "@/lib/modules/identity/ports";
import type { SessionRepo } from "@/lib/modules/session/ports";

/**
 * 关闭登录时(OWA_AUTH_REQUIRED=0,仅本地开发)使用的固定主体。
 * 开启登录后一切 web 请求都必须解析出真实用户。
 */
export const WEB_USER_ID = "local-user";

export interface AuthDeps {
  apiKeys: ApiKeyRepo;
  sessions: SessionRepo;
  /** 是否要求网页侧登录。生产必须为 true。 */
  authRequired: boolean;
  /** 从 cookie 解析当前登录用户。 */
  currentUser(req: Request): Promise<{ id: string; role?: "admin" | "user" } | null>;
}

export class Unauthorized extends Error {
  readonly status = 401;
}
export class Forbidden extends Error {
  readonly status = 403;
}

export class Authorizer {
  constructor(private readonly deps: AuthDeps) {}

  /**
   * 解析对外接口的调用方 —— 必须带有效 API Key,否则 401。
   * 校验成功后异步记录 lastUsedAt(失败不影响主流程)。
   */
  async requireApiKey(req: Request): Promise<Principal> {
    const plain = extractApiKey(req.headers);
    if (!plain) throw new Unauthorized("missing API key");
    // 形状不对就不查库,省一次往返也减少枚举噪声
    if (!looksLikeApiKey(plain)) throw new Unauthorized("invalid API key");

    const record = await this.deps.apiKeys.findByHash(hashApiKey(plain));
    if (!record) throw new Unauthorized("invalid API key");

    void this.deps.apiKeys.touch(record.id, Date.now()).catch(() => {});

    return {
      type: "apiKey",
      keyId: record.id,
      ownerId: record.ownerId,
      assistantId: record.assistantId,
    };
  }

  /**
   * 解析网页侧主体。
   * 带了 API Key 就按 key 走(便于用 key 直接调网页同款接口);否则读登录 cookie。
   */
  async resolveWeb(req: Request): Promise<Principal> {
    const plain = extractApiKey(req.headers);
    if (plain) return this.requireApiKey(req);

    const user = await this.deps.currentUser(req);
    if (user) return { type: "web", userId: user.id, role: user.role };

    // 只有显式关闭登录(本地开发)时才允许匿名
    // 关闭登录的本地开发模式:视为 admin,便于访问历史数据
    if (!this.deps.authRequired) return { type: "web", userId: WEB_USER_ID, role: "admin" };
    throw new Unauthorized("login required");
  }

  private assert(d: Decision): void {
    if (!d.allowed) throw new Forbidden(d.reason);
  }

  /** 会话归属校验:读事件流 / 工作空间文件 / 结果之前必须过这一关。 */
  async assertSessionAccess(p: Principal, sessionId: string): Promise<void> {
    const s = await this.deps.sessions.get(sessionId);
    if (!s) throw new Forbidden("session not found");
    this.assert(
      canAccessSession(p, {
        id: s.id,
        assistantId: s.assistantId,
        ownerId: s.ownerId,
        callerApiKeyId: s.callerApiKeyId,
      }),
    );
  }

  assertCanInvoke(p: Principal, assistantId: string): void {
    this.assert(canInvokeAssistant(p, assistantId));
  }

  assertCanManageAssistants(p: Principal): void {
    this.assert(canManageAssistants(p));
  }
}

/** 把授权异常翻成 HTTP 响应;非授权异常交给调用方处理。 */
export function authErrorResponse(err: unknown): Response | null {
  if (err instanceof Unauthorized) {
    return Response.json({ error: err.message }, { status: 401 });
  }
  if (err instanceof Forbidden) {
    return Response.json({ error: err.message }, { status: 403 });
  }
  return null;
}
