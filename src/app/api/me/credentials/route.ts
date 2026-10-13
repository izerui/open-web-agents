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
    const url = body.baseUrl.trim();
    const protocol = url && URL.canParse(url) ? new URL(url).protocol : "";
    if (url && protocol !== "https:" && protocol !== "http:") {
      return Response.json({ error: "Base URL 须为 http/https 地址" }, { status: 400 });
    }
    patch.defaultBaseUrl = url || null;
  }
  if (body.apiKey !== undefined) {
    const plain = body.apiKey.trim();
    patch.anthropicKeyEnc = plain ? secrets.encrypt(plain) : null;
  }

  // 自定义网关必须配自己的 key:运行时凭证链不会把平台 key 发往用户自定义的地址,
  // 在这里就拦住,免得保存成功、每次运行才失败
  const nextBase = patch.defaultBaseUrl !== undefined ? patch.defaultBaseUrl : user.defaultBaseUrl;
  const nextKey =
    patch.anthropicKeyEnc !== undefined ? patch.anthropicKeyEnc : user.anthropicKeyEnc;
  if (nextBase && !nextKey) {
    return Response.json(
      { error: "设置自定义 Base URL 时必须同时配置自己的 API Key" },
      { status: 400 },
    );
  }

  await users.setCredentials(user.id, patch);
  // 只记"改了什么",不记值:Base URL 可能带令牌,Key 更不必说
  await getContainer().audit.record({
    actor: { type: "web", userId: user.id },
    action: "me.credentials_update",
    resource: { type: "account", id: user.id },
    ownerId: user.id,
    details: {
      baseUrl:
        patch.defaultBaseUrl === undefined ? "unchanged" : patch.defaultBaseUrl ? "set" : "cleared",
      modelKey:
        patch.anthropicKeyEnc === undefined
          ? "unchanged"
          : patch.anthropicKeyEnc
            ? "set"
            : "cleared",
    },
    req,
  });

  const updated = await users.get(user.id);
  const decrypted = updated?.anthropicKeyEnc ? secrets.decrypt(updated.anthropicKeyEnc) : null;
  return Response.json({
    defaultBaseUrl: updated?.defaultBaseUrl ?? null,
    anthropicKeyMask: decrypted ? maskSecret(decrypted) : null,
  });
}
