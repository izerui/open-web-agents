import { createHash } from "node:crypto";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 不透明的来源分组:构建器据此只让子代理选与主模型同一来源的模型,但看不出是哪家提供者。 */
function groupOf(providerId: string): string {
  return createHash("sha256").update(`owa-model-group:${providerId}`).digest("hex").slice(0, 12);
}

/**
 * 用户可见的模型与售价。不含提供者、真实模型标识与任何凭证;
 * 管理员维护模型走 /api/admin/models。
 */
export async function GET(req: Request) {
  const { auth, capabilities, providers, modelAliases, ensureModels } = getContainer();
  try {
    await auth.resolveWeb(req);
    await ensureModels();
    const [catalog, providerList, aliases] = await Promise.all([
      capabilities.list(),
      providers.list(),
      modelAliases.get(),
    ]);
    const byId = new Map(providerList.map((p) => [p.id, p]));
    return Response.json(
      {
        capabilities: catalog.map((m) => {
          const provider = byId.get(m.providerId ?? "");
          return {
            id: m.id,
            name: m.name,
            kind: m.kind,
            acceptsImages: m.acceptsImages,
            rates: m.rates,
            version: m.version,
            group: groupOf(m.providerId ?? ""),
            // 只有文本模型接入了运行时;生图等类型仅用于展示价目
            available:
              m.kind === "llm" &&
              !!provider?.enabled &&
              !!provider.endpoints.llm &&
              provider.hasKey,
          };
        }),
        // 别名当前指向的模型,构建器显示"跟随平台默认"用
        aliases: aliases
          ? {
              fable: aliases.fable,
              opus: aliases.opus,
              sonnet: aliases.sonnet,
              haiku: aliases.haiku,
            }
          : null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const response = authErrorResponse(err);
    if (response) return response;
    throw err;
  }
}
