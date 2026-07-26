import { getContainer } from "@/lib/container";
import { maskSecret } from "@/lib/modules/identity/domain/secret-box";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  /** 用户级 base_url 覆盖;空串表示清除。 */
  baseUrl?: string;
  /** 用户自带的 Anthropic key 明文;空串表示清除。加密入库。 */
  apiKey?: string;
}

/**
 * 设置"每用户自带凭证"(设计文稿 §9)。
 * key 用 AES-GCM 加密入库,只在运行时解密注入 agent 子进程;界面只回掩码。
 */
export async function PUT(req: Request) {
  const { authService, users, secrets } = getContainer();

  const user = await authService.currentUser(req);
  if (!user) return Response.json({ error: "login required" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as Body;

  const patch: { defaultBaseUrl?: string | null; anthropicKeyEnc?: string | null } = {};
  if (body.baseUrl !== undefined) {
    patch.defaultBaseUrl = body.baseUrl.trim() || null;
  }
  if (body.apiKey !== undefined) {
    const plain = body.apiKey.trim();
    patch.anthropicKeyEnc = plain ? secrets.encrypt(plain) : null;
  }

  await users.setCredentials(user.id, patch);

  const updated = await users.get(user.id);
  const decrypted = updated?.anthropicKeyEnc ? secrets.decrypt(updated.anthropicKeyEnc) : null;
  return Response.json({
    defaultBaseUrl: updated?.defaultBaseUrl ?? null,
    anthropicKeyMask: decrypted ? maskSecret(decrypted) : null,
  });
}
