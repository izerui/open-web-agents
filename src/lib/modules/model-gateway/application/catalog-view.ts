import type { ModelCatalogView } from "@/lib/modules/agent/domain/validate-config";
import type { CapabilityRepo } from "@/lib/modules/capabilities/ports";
import { isModelAlias } from "@/lib/shared";
import type { ModelAliasRepo, ProviderRepo } from "../ports";

export interface CatalogViewDeps {
  ensureModels: () => Promise<void>;
  capabilities: CapabilityRepo;
  providers: ProviderRepo;
  aliases: ModelAliasRepo;
}

/** 给配置校验与调用受理用的只读模型目录:别名按当前映射解析,来源用提供者 id(调用方只当不透明值)。 */
export async function loadModelCatalogView(deps: CatalogViewDeps): Promise<ModelCatalogView> {
  await deps.ensureModels();
  const [models, providers, aliases] = await Promise.all([
    deps.capabilities.list(true),
    deps.providers.list(),
    deps.aliases.get(),
  ]);
  const byId = new Map(models.map((m) => [m.id, m]));
  const providerEnabled = new Map(providers.map((p) => [p.id, p.enabled]));
  return {
    resolve(ref) {
      const id = isModelAlias(ref) ? aliases?.[ref] : ref;
      const m = id ? byId.get(id) : undefined;
      if (!m) return null;
      return {
        name: m.name,
        kind: m.kind,
        enabled: m.enabled && providerEnabled.get(m.providerId ?? "") === true,
        group: m.providerId ?? "",
      };
    },
  };
}
