import type { Capability } from "@/lib/modules/capabilities/domain/catalog";
import type { CapabilityRepo } from "@/lib/modules/capabilities/ports";
import type { ModelRef, ResolvedCredentials } from "@/lib/shared";
import { type PinnedPricing, isUnavailableAtAdmission } from "@/lib/shared";
import {
  ModelUnavailable,
  type ModelUnavailableCode,
  type RunModelBinding,
  resolvePinnedModels,
  resolveRunModels,
} from "../domain/resolve-run-models";
import type { ModelAliasRepo, ProviderRepo } from "../ports";

export interface ModelResolverDeps {
  ensureModels: () => Promise<void>;
  capabilities: CapabilityRepo;
  providers: ProviderRepo;
  aliases: ModelAliasRepo;
  /** SecretBox.decrypt:解不开返回 null */
  decrypt: (stored: string) => string | null;
}

export interface ResolveRequest {
  main: ModelRef;
  override?: ModelRef;
  subagents?: { name: string; model?: ModelRef }[];
}

export interface ResolvedRun {
  binding: RunModelBinding;
  credentials: ResolvedCredentials;
}

export class ModelResolver {
  constructor(private readonly deps: ModelResolverDeps) {}

  /** 只解析绑定(受理时用):不碰凭证。模型不可用照样抛 ModelUnavailable。 */
  async bind(req: ResolveRequest): Promise<RunModelBinding> {
    await this.deps.ensureModels();
    const [models, providers, aliases] = await Promise.all([
      this.deps.capabilities.list(true),
      this.deps.providers.list(),
      this.deps.aliases.get(),
    ]);
    return resolveRunModels({ ...req, models, providers, aliases });
  }

  /** 执行时用:有受理时锁定的绑定就按它(锁定版本),否则按配置现解析;再解密凭证。 */
  async resolve(req: ResolveRequest & { pinned?: PinnedPricing | null }): Promise<ResolvedRun> {
    // 受理时就不可用:照此失败,不重新解析 —— 排队期间模型被重新启用也不能让它绕过受理检查去调用模型
    if (isUnavailableAtAdmission(req.pinned)) {
      const u = req.pinned.unavailableAtAdmission;
      throw new ModelUnavailable(u.code as ModelUnavailableCode, u.message);
    }
    const pinned = req.pinned?.binding ? req.pinned : null;
    const binding = pinned
      ? await this.bindPinned(pinned as Parameters<typeof resolvePinnedModels>[0]["pricing"])
      : await this.bind(req);
    const stored = await this.deps.providers.keyEnc(binding.providerId);
    if (!stored) throw new ModelUnavailable("not_configured", "平台尚未完成模型配置,请联系管理员");
    // 解不开(主密钥换过或密文损坏)必须报错:静默当成空 Key 只会让上游返回难以排查的 401
    const key = this.deps.decrypt(stored);
    if (!key) throw new Error("模型提供者凭证无法解密(主密钥可能已更换),请管理员重新填写 Key");
    return { binding, credentials: { baseUrl: binding.baseUrl, key } };
  }

  private async bindPinned(
    pricing: Parameters<typeof resolvePinnedModels>[0]["pricing"],
  ): Promise<RunModelBinding> {
    await this.deps.ensureModels();
    const [models, providers] = await Promise.all([
      this.deps.capabilities.list(true),
      this.deps.providers.list(),
    ]);
    const versions = new Map<string, Capability>();
    for (const m of pricing.models) {
      const v = await this.deps.capabilities.version(m.capabilityId, m.version);
      if (v) {
        const { createdBy: _, ...cap } = v;
        versions.set(m.capabilityId, cap);
      }
    }
    return resolvePinnedModels({ pricing, models, providers, versions });
  }
}
