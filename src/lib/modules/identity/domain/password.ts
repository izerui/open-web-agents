// 密码哈希。用 scrypt(Node 内置,无需额外依赖,抗 GPU 暴力优于 PBKDF2)。
//
// 存储格式:`scrypt$N$r$p$salt_b64$hash_b64` —— 参数随哈希一起存,
// 将来调参不会让老密码失效(校验时按记录里的参数重算)。

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

/** 默认参数:约 100ms 量级,兼顾安全与登录体验。 */
const DEFAULTS = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 32;
const SALT_LEN = 16;

export async function hashPassword(plain: string): Promise<string> {
  if (!plain) throw new Error("password must not be empty");
  const salt = randomBytes(SALT_LEN);
  const { N, r, p } = DEFAULTS;
  const hash = await scrypt(plain, salt, KEY_LEN, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/**
 * 校验密码。格式非法或参数解析失败一律判否 —— 绝不因为记录损坏而放行。
 * 比较用常量时间,防定时攻击。
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  if (!plain || !stored) return false;

  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] ?? "", "base64");
    expected = Buffer.from(parts[5] ?? "", "base64");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = await scrypt(plain, salt, expected.length, { N, r, p });
  } catch {
    return false; // 参数超出 scrypt 允许范围等
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
