// 嵌入令牌:让浏览器里的 widget 能直连平台,而【不必持有 API Key】。
//
// 设计文稿 §8 的硬约束:key 绝不下发浏览器。所以流程是三段:
//   ① 企业自己的后端(持有 API Key)向平台换一枚短时效令牌
//   ② 后端把令牌交给自家页面上的 widget
//   ③ widget 拿令牌直连平台跑会话
// 令牌泄露的爆炸半径被限死:短时效 + 绑定单个会话 + 只能跑不能管。
//
// 格式 `v1.<payload-b64url>.<sig>`,签名覆盖 payload;payload 明文可读但改不了。

import { createHmac, timingSafeEqual } from "node:crypto";

export interface EmbedClaims {
  /** 允许调用的智能体。 */
  agentId: string;
  /** 绑定的会话 —— 令牌只能操作这一个会话,拿到也读不了别人的。 */
  sessionId: string;
  /** 签发它的 API Key id,用于审计与吊销追溯。 */
  keyId: string;
  expiresAt: number;
}

const VERSION = "v1";

function sign(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function issueEmbedToken(
  secret: string,
  claims: Omit<EmbedClaims, "expiresAt">,
  ttlMs: number,
  now = Date.now(),
): string {
  if (!secret) throw new Error("embed secret must not be empty");
  if (ttlMs <= 0) throw new Error("ttl must be positive");

  const payload: EmbedClaims = { ...claims, expiresAt: now + ttlMs };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${VERSION}.${encoded}.${sign(secret, encoded)}`;
}

/**
 * 校验并解出令牌。
 * 任何异常(格式/签名/过期)一律返回 null,不区分原因 —— 避免把失败细节泄露给探测者。
 */
export function verifyEmbedToken(
  secret: string,
  token: string,
  now = Date.now(),
): EmbedClaims | null {
  if (!secret || !token) return null;

  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return null;

  const encoded = parts[1] ?? "";
  const provided = parts[2] ?? "";
  const expected = sign(secret, encoded);

  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let claims: EmbedClaims;
  try {
    claims = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as EmbedClaims;
  } catch {
    return null;
  }

  if (
    !claims?.agentId ||
    !claims.sessionId ||
    !claims.keyId ||
    !Number.isFinite(claims.expiresAt) ||
    claims.expiresAt <= now
  ) {
    return null;
  }
  return claims;
}

/** 从请求头取嵌入令牌。与 API Key 分开走,避免两种凭证混淆。 */
export function extractEmbedToken(headers: { get(name: string): string | null }): string | null {
  const v = headers.get("x-embed-token");
  return v?.trim() || null;
}

/** 嵌入令牌的默认有效期:够聊一会儿,又不至于泄露后长期可用。 */
export const EMBED_TTL_MS = 30 * 60_000;
