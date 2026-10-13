import { randomBytes } from "node:crypto";
import { getContainer } from "@/lib/container";
import { maskSecret } from "@/lib/modules/identity/domain/secret-box";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 自定义密钥的最短长度。太短的 HMAC 密钥能被离线暴力破解。 */
const MIN_SECRET_CHARS = 24;
const MAX_SECRET_CHARS = 256;

/**
 * 设置 / 生成当前用户的 webhook 签名密钥。
 *
 * 该用户名下所有智能体的回调都用它签名(X-OWA-Signature),接收方用同一个密钥验签,
 * 据此确认回调确实来自平台、且内容没被改过。
 *
 * - body 带 secret:使用用户自己提供的密钥
 * - body 不带 secret:平台生成一个
 * 明文只在这次响应里返回一次,之后界面只显示掩码。
 */
export async function POST(req: Request) {
  const { authService, users, secrets } = getContainer();
  const user = await authService.currentUser(req);
  if (!user) return Response.json({ error: "login required" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { secret?: string };
  let secret: string;
  if (typeof body.secret === "string" && body.secret.trim()) {
    secret = body.secret.trim();
    if (secret.length < MIN_SECRET_CHARS || secret.length > MAX_SECRET_CHARS) {
      return Response.json(
        { error: `密钥长度须在 ${MIN_SECRET_CHARS}~${MAX_SECRET_CHARS} 字符之间` },
        { status: 400 },
      );
    }
  } else {
    secret = `whsec_${randomBytes(32).toString("base64url")}`;
  }

  await users.setCredentials(user.id, { webhookSecretEnc: secrets.encrypt(secret) });
  return Response.json({ secret, mask: maskSecret(secret) }, { status: 201 });
}

/** 清除签名密钥。之后回调不再带签名头。 */
export async function DELETE(req: Request) {
  const { authService, users } = getContainer();
  const user = await authService.currentUser(req);
  if (!user) return Response.json({ error: "login required" }, { status: 401 });
  await users.setCredentials(user.id, { webhookSecretEnc: null });
  return Response.json({ cleared: true });
}
