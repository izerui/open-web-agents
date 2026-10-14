// 回调签名用哪把(几把)密钥。纯逻辑:解密由调用方注入。
//
// 换密钥后有一段重叠期:旧密钥在重叠期内额外签一份(X-OWA-Signature-Previous),
// 接收方来得及换上新密钥,验签不中断。

export interface StoredSigningSecrets {
  webhookSecretEnc?: string;
  webhookSecretPrevEnc?: string;
  webhookSecretPrevUntil?: number;
}

export function signingSecretsOf(
  u: StoredSigningSecrets,
  decrypt: (enc: string) => string | null,
  now: number,
  who = "",
): { secret: string; previousSecret?: string } | undefined {
  if (!u.webhookSecretEnc) return undefined;
  const secret = decrypt(u.webhookSecretEnc);
  // 配置了却解不开:必须失败 —— 不能退化成不签名照发
  if (secret === null) throw new Error(`webhook 签名密钥无法解密${who ? `(${who})` : ""}`);
  const inOverlap = Boolean(u.webhookSecretPrevEnc) && (u.webhookSecretPrevUntil ?? 0) > now;
  // 旧密钥只是过渡期的附加签名:解不开就不带,主签名不受影响
  const previousSecret = inOverlap ? decrypt(u.webhookSecretPrevEnc as string) : null;
  return { secret, ...(previousSecret ? { previousSecret } : {}) };
}
