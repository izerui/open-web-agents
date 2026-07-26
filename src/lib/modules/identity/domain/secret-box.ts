// 用户凭证的对称加密(AES-256-GCM)。
//
// 为什么要加密而非哈希:用户的 Anthropic key 需要【原样取回】注入 agent 子进程,
// 所以是可逆加密。GCM 自带完整性校验 —— 密文被篡改会解密失败而不是静默产出垃圾。
//
// 存储格式:`v1$iv_b64$tag_b64$cipher_b64`,版本号留给将来换算法/轮换主密钥。

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const IV_LEN = 12; // GCM 推荐 96 位
const VERSION = "v1";

/** 由主密钥派生 32 字节 AES key —— 允许主密钥是任意长度的口令。 */
function deriveKey(masterKey: string): Buffer {
  if (!masterKey) throw new Error("master key must not be empty");
  return createHash("sha256").update(masterKey, "utf8").digest();
}

export class SecretBox {
  private readonly key: Buffer;

  constructor(masterKey: string) {
    this.key = deriveKey(masterKey);
  }

  encrypt(plain: string): string {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(
      "$",
    );
  }

  /** 解密失败(格式错/被篡改/换了主密钥)返回 null,由调用方决定降级行为。 */
  decrypt(stored: string): string | null {
    const parts = stored.split("$");
    if (parts.length !== 4 || parts[0] !== VERSION) return null;
    try {
      const iv = Buffer.from(parts[1] ?? "", "base64");
      const tag = Buffer.from(parts[2] ?? "", "base64");
      const enc = Buffer.from(parts[3] ?? "", "base64");
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
    } catch {
      return null;
    }
  }
}

/** 只显示尾部若干位,用于界面回显"已配置"而不泄露完整密钥。 */
export function maskSecret(plain: string, tailLen = 4): string {
  if (!plain) return "";
  if (plain.length <= tailLen) return "*".repeat(plain.length);
  return `${"*".repeat(Math.min(8, plain.length - tailLen))}${plain.slice(-tailLen)}`;
}
