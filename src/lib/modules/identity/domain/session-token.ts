// 登录会话令牌:HMAC 签名的自包含 token,不需要服务端会话表。
//
// 格式 `userId.expiresAt.sig` —— 签名覆盖前两段,任何篡改都会验签失败。
// 过期时间放在明文里但被签名保护,故客户端改不了。

import { createHmac, timingSafeEqual } from "node:crypto";

export interface TokenPayload {
  userId: string;
  expiresAt: number;
}

function sign(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function issueToken(
  secret: string,
  userId: string,
  ttlMs: number,
  now = Date.now(),
): string {
  if (!secret) throw new Error("session secret must not be empty");
  if (userId.includes(".")) throw new Error("userId must not contain '.'");
  const data = `${userId}.${now + ttlMs}`;
  return `${data}.${sign(secret, data)}`;
}

/**
 * 校验并解出 token。任何异常(格式/签名/过期)一律返回 null,不区分原因 ——
 * 对外只说"登录无效",避免把失败细节泄露给攻击者做探测。
 */
export function verifyToken(secret: string, token: string, now = Date.now()): TokenPayload | null {
  if (!secret || !token) return null;

  const idx = token.lastIndexOf(".");
  if (idx <= 0) return null;

  const data = token.slice(0, idx);
  const providedSig = token.slice(idx + 1);
  const expectedSig = sign(secret, data);

  const a = Buffer.from(providedSig, "utf8");
  const b = Buffer.from(expectedSig, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const dot = data.indexOf(".");
  if (dot <= 0) return null;
  const userId = data.slice(0, dot);
  const expiresAt = Number(data.slice(dot + 1));
  if (!userId || !Number.isFinite(expiresAt) || expiresAt <= now) return null;

  return { userId, expiresAt };
}

export const SESSION_COOKIE = "owa_session";

/** 从 Cookie 头里取出登录令牌。 */
export function readSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === SESSION_COOKIE) {
      const v = rest.join("=").trim();
      return v || null;
    }
  }
  return null;
}

/** 构造 Set-Cookie。HttpOnly 防 XSS 窃取;SameSite=Lax 防基本 CSRF。 */
export function buildSessionCookie(token: string, ttlMs: number, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(ttlMs / 1000)}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function buildClearCookie(secure: boolean): string {
  const attrs = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}
