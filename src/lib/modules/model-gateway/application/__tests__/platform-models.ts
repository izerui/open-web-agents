// 编排器测试用的模型解析:真实 ModelResolver + 内存仓库。四个别名各指向一个模型(model-<别名>)。
import { InMemoryCapabilityRepo } from "@/lib/modules/capabilities/adapters/in-memory-capability-repo";
import {
  InMemoryModelAliasRepo,
  InMemoryProviderRepo,
} from "@/lib/modules/model-gateway/adapters/in-memory-provider-repo";
import {
  ModelResolver,
  type ResolveRequest,
} from "@/lib/modules/model-gateway/application/model-resolver";
import type { ModelAliasRepo, ProviderRepo } from "@/lib/modules/model-gateway/ports";
import { MODEL_ALIASES } from "@/lib/shared";

export const PROVIDER_ID = "platform-default";

export function platformModels(creds: { baseUrl: string; key: string }) {
  const capabilities = new InMemoryCapabilityRepo();
  const providers: ProviderRepo = new InMemoryProviderRepo();
  const aliases: ModelAliasRepo = new InMemoryModelAliasRepo();
  const ready = (async () => {
    await providers.save(
      {
        id: PROVIDER_ID,
        name: "平台默认",
        enabled: true,
        endpoints: creds.baseUrl ? { llm: { protocol: "anthropic", baseUrl: creds.baseUrl } } : {},
      },
      null,
      "test",
    );
    if (creds.key) await providers.setKey(PROVIDER_ID, `enc:${creds.key}`, "****", "test");
    for (const alias of MODEL_ALIASES) {
      await capabilities.save(
        {
          id: `m-${alias}`,
          name: `模型 ${alias}`,
          kind: "llm",
          modelId: `model-${alias}`,
          enabled: true,
          acceptsImages: false,
          providerId: PROVIDER_ID,
          markupBp: 0,
          costRates: [{ meter: "input_token", units: "1000000", microCredits: "0" }],
          rates: [],
        },
        null,
        "test",
      );
    }
    await aliases.save(
      {
        providerId: PROVIDER_ID,
        fable: "m-fable",
        opus: "m-opus",
        sonnet: "m-sonnet",
        haiku: "m-haiku",
      },
      null,
      "test",
    );
  })();
  const resolver = new ModelResolver({
    ensureModels: () => ready,
    capabilities,
    providers,
    aliases,
    decrypt: (stored) => (stored.startsWith("enc:") ? stored.slice(4) : null),
  });
  const resolveModels = (req: Parameters<ModelResolver["resolve"]>[0]) => resolver.resolve(req);
  return Object.assign(resolveModels, { capabilities, providers, aliases, ready });
}
