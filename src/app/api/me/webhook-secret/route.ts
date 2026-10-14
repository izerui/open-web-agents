import { randomBytes } from "node:crypto";
import { getContainer } from "@/lib/container";
import { parseGraceHours } from "@/lib/modules/identity/domain/api-key";
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

  const body = (await req.json().catch(() => ({}))) as { secret?: string; graceHours?: unknown };
  // 换密钥的重叠期:旧密钥在这段时间里仍额外签一份,接收方来得及换上新密钥
  const grace = parseGraceHours(body.graceHours);
  if (!grace.ok) return Response.json({ error: grace.reason }, { status: 400 });
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

  const current = await users.get(user.id);
  const overlapUntil =
    current?.webhookSecretEnc && grace.hours > 0 ? Date.now() + grace.hours * 3_600_000 : null;
  await users.setCredentials(user.id, {
    webhookSecretEnc: secrets.encrypt(secret),
    // 原来就有密钥才有重叠期;重叠期为 0 即刻作废旧密钥
    webhookSecretPrevEnc: overlapUntil ? (current?.webhookSecretEnc ?? null) : null,
    webhookSecretPrevUntil: overlapUntil,
  });
  await getContainer().audit.record({
    actor: { type: "web", userId: user.id },
    action: "me.webhook_secret_set",
    resource: { type: "account", id: user.id },
    ownerId: user.id,
    details: {
      generated: !(typeof body.secret === "string" && body.secret.trim()),
      ...(overlapUntil ? { previousValidUntil: new Date(overlapUntil).toISOString() } : {}),
    },
    req,
  });
  return Response.json(
    {
      secret,
      mask: maskSecret(secret),
      /** 旧密钥在这之前仍额外签一份(X-OWA-Signature-Previous);没有旧密钥或重叠期为 0 则为 null */
      previousValidUntil: overlapUntil ? new Date(overlapUntil).toISOString() : null,
    },
    { status: 201 },
  );
}

/** 清除签名密钥。之后回调不再带签名头。 */
export async function DELETE(req: Request) {
  const { authService, users } = getContainer();
  const user = await authService.currentUser(req);
  if (!user) return Response.json({ error: "login required" }, { status: 401 });
  // 清除就是不再签名:旧密钥一并作废
  await users.setCredentials(user.id, {
    webhookSecretEnc: null,
    webhookSecretPrevEnc: null,
    webhookSecretPrevUntil: null,
  });
  await getContainer().audit.record({
    actor: { type: "web", userId: user.id },
    action: "me.webhook_secret_clear",
    resource: { type: "account", id: user.id },
    ownerId: user.id,
    req,
  });
  return Response.json({ cleared: true });
}
