// API Key 的生成与校验。
//
// 安全约定:
// ① 明文只在创建时返回一次,库里只存 SHA-256 哈希 —— 库被读走也不能直接拿去调用;
// ② 比较用常量时间,避免按字节提前返回泄露前缀信息(定时攻击);
// ③ 前缀 owa_ 便于在日志/告警里一眼识别并触发轮换。

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const KEY_PREFIX = "owa_";

/** 生成一个新密钥的明文。32 字节熵,base64url 无需转义。 */
export function generateApiKey(): string {
  return KEY_PREFIX + randomBytes(32).toString("base64url");
}

/** 明文 → 存库用的哈希(hex,64 字符)。 */
export function hashApiKey(plain: string): string {
  return createHash("sha256").update(plain, "utf8").digest("hex");
}

/** 形状检查:在查库前挡掉明显不是本平台密钥的输入。 */
export function looksLikeApiKey(v: string): boolean {
  return v.startsWith(KEY_PREFIX) && v.length >= KEY_PREFIX.length + 20;
}

/** 常量时间比较两个哈希,防定时攻击。 */
export function safeEqualHash(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // 长度不同直接判否 —— timingSafeEqual 要求等长,且长度本身不是秘密
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** 从请求头取密钥。支持 X-Api-Key 与 Authorization: Bearer。 */
export function extractApiKey(headers: {
  get(name: string): string | null;
}): string | null {
  const direct = headers.get("x-api-key");
  if (direct?.trim()) return direct.trim();

  const auth = headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    const v = auth.slice(7).trim();
    if (v) return v;
  }
  return null;
}

/** 已过期:到期时刻已到(含正好到点)。没有到期时刻的 Key 不过期。 */
export function isKeyExpired(k: { expiresAt?: number }, now: number): boolean {
  return k.expiresAt !== undefined && k.expiresAt <= now;
}

/** 签发时的有效天数:不传 = 不过期;1~3650 天。 */
export function parseExpiresInDays(
  raw: unknown,
): { ok: true; days?: number } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 3650) {
    return { ok: false, reason: "expiresInDays 须为 1~3650 的整数" };
  }
  return { ok: true, days: raw };
}

/** 轮换的重叠期:旧 Key 再有效多久(小时),默认 24,0~168。 */
export function parseGraceHours(
  raw: unknown,
): { ok: true; hours: number } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) return { ok: true, hours: 24 };
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 168) {
    return { ok: false, reason: "graceHours 须为 0~168 的整数" };
  }
  return { ok: true, hours: raw };
}

/**
 * 轮换:新 Key 沿用旧 Key 的有效时长(旧的不过期,新的也不过期);旧 Key 的到期时刻提前到
 * "现在 + 重叠期",但不会因此延长 —— 本来就更早到期的保持不变。
 */
export function rotationPlan(
  old: { createdAt: number; expiresAt?: number },
  now: number,
  graceHours: number,
): { newExpiresAt?: number; oldExpiresAt: number } {
  const graceEnd = now + graceHours * 3_600_000;
  return {
    newExpiresAt: old.expiresAt === undefined ? undefined : now + (old.expiresAt - old.createdAt),
    oldExpiresAt: old.expiresAt === undefined ? graceEnd : Math.min(old.expiresAt, graceEnd),
  };
}
