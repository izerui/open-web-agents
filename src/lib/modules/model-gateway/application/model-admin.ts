// 管理员维护提供者、模型与别名映射。路由只负责鉴权、审计与错误映射。
import { randomUUID } from "node:crypto";
import type { AgentModelRefsQuery } from "@/lib/modules/agent/ports";
import {
  CAPABILITY_KINDS,
  type Capability,
  type CapabilityDefinition,
  type CapabilityKind,
  validateCapability,
} from "@/lib/modules/capabilities/domain/catalog";
import { STANDARD_METERS } from "@/lib/modules/capabilities/domain/pricing";
import {
  CapabilityConflict,
  type CapabilityRepo,
  DuplicateModelId,
} from "@/lib/modules/capabilities/ports";
import { BrandedError, MODEL_ALIASES } from "@/lib/shared";
import { type Impact, type ImpactTarget, countImpact } from "../domain/impact";
import {
  type ModelAliases,
  type Provider,
  normalizeBaseUrl,
  validateAliasMap,
  validateProvider,
} from "../domain/provider";
import {
  type ModelAliasRepo,
  type ProbeResult,
  ProviderConflict,
  type ProviderProbe,
  type ProviderRepo,
} from "../ports";

export class ModelAdminError extends BrandedError {
  static readonly brand = Symbol.for("owa.error.ModelAdminError");
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: "invalid_request" | "not_found" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

export interface ModelAdminDeps {
  ensureModels: () => Promise<void>;
  capabilities: CapabilityRepo;
  providers: ProviderRepo;
  aliases: ModelAliasRepo;
  agentRefs: AgentModelRefsQuery;
  probe: ProviderProbe;
  encrypt: (plain: string) => string;
  decrypt: (stored: string) => string | null;
  mask: (plain: string) => string;
}

export interface ProviderOverview extends Provider {
  modelCounts: Record<CapabilityKind, number>;
}

export interface AdminModel extends Capability {
  providerName: string | null;
}

/** 领域校验:任何失败都是"输入不合法" */
function valid<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new ModelAdminError(
      400,
      "invalid_request",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** 仓库写入:只把冲突翻译成 409,其余(如数据库故障)原样抛出 */
async function conflicts<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (
      err instanceof ProviderConflict ||
      err instanceof CapabilityConflict ||
      err instanceof DuplicateModelId
    ) {
      throw new ModelAdminError(409, "conflict", err.message);
    }
    throw err;
  }
}

function apiKeyOf(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim() || raw.trim().length > 1000 || /\s/.test(raw.trim())) {
    throw new ModelAdminError(400, "invalid_request", "API Key 须为 1~1000 个不含空白的字符");
  }
  return raw.trim();
}

function versionOf(raw: unknown): number | null {
  if (raw === null) return null;
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
  throw new ModelAdminError(400, "invalid_request", "expectedVersion 须为正整数,新建时为 null");
}

export class ModelAdmin {
  constructor(private readonly deps: ModelAdminDeps) {}

  private async provider(id: string): Promise<Provider> {
    const p = await this.deps.providers.get(id);
    if (!p) throw new ModelAdminError(404, "not_found", "提供者不存在");
    return p;
  }

  async overview(): Promise<{ providers: ProviderOverview[]; aliases: ModelAliases | null }> {
    await this.deps.ensureModels();
    const [providers, models, aliases] = await Promise.all([
      this.deps.providers.list(),
      this.deps.capabilities.list(true),
      this.deps.aliases.get(),
    ]);
    return {
      providers: providers.map((p) => {
        const modelCounts = Object.fromEntries(CAPABILITY_KINDS.map((k) => [k, 0])) as Record<
          CapabilityKind,
          number
        >;
        for (const m of models) if (m.providerId === p.id) modelCounts[m.kind] += 1;
        return { ...p, modelCounts };
      }),
      aliases,
    };
  }

  async getProvider(id: string): Promise<Provider> {
    await this.deps.ensureModels();
    return this.provider(id);
  }

  async createProvider(input: { definition?: unknown; apiKey?: unknown }, actor: string) {
    await this.deps.ensureModels();
    const raw = (input.definition ?? {}) as Record<string, unknown>;
    const key = input.apiKey === undefined || input.apiKey === "" ? null : apiKeyOf(input.apiKey);
    const def = valid(() =>
      validateProvider({ ...raw, id: raw.id ?? `p-${randomUUID().slice(0, 8)}` }),
    );
    const saved = await conflicts(() => this.deps.providers.save(def, null, actor));
    if (key) {
      await this.deps.providers.setKey(
        saved.id,
        this.deps.encrypt(key),
        this.deps.mask(key),
        actor,
      );
    }
    return this.provider(saved.id);
  }

  async updateProvider(
    id: string,
    input: { definition?: unknown; expectedVersion?: unknown },
    actor: string,
  ) {
    await this.deps.ensureModels();
    await this.provider(id);
    const expected = versionOf(input.expectedVersion ?? null);
    if (expected === null)
      throw new ModelAdminError(400, "invalid_request", "修改须带 expectedVersion");
    const def = valid(() => validateProvider({ ...(input.definition as object), id }));
    return conflicts(() => this.deps.providers.save(def, expected, actor));
  }

  async replaceKey(id: string, apiKey: unknown, actor: string): Promise<{ keyHint: string }> {
    await this.deps.ensureModels();
    await this.provider(id);
    const key = apiKeyOf(apiKey);
    const keyHint = this.deps.mask(key);
    await this.deps.providers.setKey(id, this.deps.encrypt(key), keyHint, actor);
    return { keyHint };
  }

  /** 可用表单里还没保存的地址与 Key;不传就用已保存的。 */
  async testConnection(
    id: string,
    input: { modelId?: unknown; baseUrl?: unknown; apiKey?: unknown },
  ): Promise<ProbeResult> {
    await this.deps.ensureModels();
    const p = await this.provider(id);
    if (typeof input.modelId !== "string" || !input.modelId.trim() || input.modelId.length > 200) {
      throw new ModelAdminError(400, "invalid_request", "须填写用于测试的模型标识");
    }
    const baseUrl = valid(() => normalizeBaseUrl(input.baseUrl ?? p.endpoints.llm?.baseUrl ?? ""));
    let key: string;
    if (input.apiKey !== undefined && input.apiKey !== "") {
      key = apiKeyOf(input.apiKey);
    } else {
      const stored = await this.deps.providers.keyEnc(id);
      if (!stored) throw new ModelAdminError(400, "invalid_request", "该提供者还没有 API Key");
      const plain = this.deps.decrypt(stored);
      if (!plain) {
        throw new ModelAdminError(400, "invalid_request", "已保存的 API Key 无法解密,请重新填写");
      }
      key = plain;
    }
    return this.deps.probe.testAnthropic({ baseUrl, key, modelId: input.modelId.trim() });
  }

  async listModels(): Promise<AdminModel[]> {
    await this.deps.ensureModels();
    const [models, providers] = await Promise.all([
      this.deps.capabilities.list(true),
      this.deps.providers.list(),
    ]);
    const names = new Map(providers.map((p) => [p.id, p.name]));
    return models.map((m) => ({ ...m, providerName: names.get(m.providerId ?? "") ?? null }));
  }

  /** 新模型必须按成本价录入、挂在已存在的提供者下;售价由服务端派生。 */
  async saveModel(input: { definition?: unknown; expectedVersion?: unknown }, actor: string) {
    await this.deps.ensureModels();
    const raw = { ...(input.definition as Record<string, unknown>) };
    raw.id ??= `m-${randomUUID().slice(0, 8)}`;
    const expected = versionOf(input.expectedVersion ?? null);
    const def: CapabilityDefinition = valid(() => validateCapability(raw));
    if (!def.providerId) throw new ModelAdminError(400, "invalid_request", "须选择提供者");
    if (!def.costRates) throw new ModelAdminError(400, "invalid_request", "须按成本价录入价格");
    // 缺任何一项,产生该类用量时整次运行都无法定价(输入费用也算不出):启用前必须填全,不收费填 0
    if (def.enabled) {
      const missing = STANDARD_METERS[def.kind].filter(
        (m) => !def.costRates?.some((r) => r.meter === m.meter),
      );
      if (missing.length) {
        throw new ModelAdminError(
          400,
          "invalid_request",
          `启用前须填写完整价格,缺少:${missing.map((m) => m.label).join("、")}(不收费的项请填 0)`,
        );
      }
    }
    await this.provider(def.providerId);
    const current = await this.deps.capabilities.get(def.id);
    if (current?.providerId && current.providerId !== def.providerId) {
      throw new ModelAdminError(
        400,
        "invalid_request",
        "模型不能移到其他提供者,请在目标提供者下新建",
      );
    }
    return conflicts(() => this.deps.capabilities.save(def, expected, actor));
  }

  async saveAliases(input: Record<string, unknown>, actor: string): Promise<ModelAliases> {
    await this.deps.ensureModels();
    const map = valid(() => validateAliasMap(input));
    const provider = await this.provider(map.providerId);
    if (!provider.enabled) throw new ModelAdminError(400, "invalid_request", "提供者已停用");
    for (const alias of MODEL_ALIASES) {
      const m = await this.deps.capabilities.get(map[alias]);
      if (!m || m.kind !== "llm" || !m.enabled || m.providerId !== map.providerId) {
        throw new ModelAdminError(
          400,
          "invalid_request",
          `${alias} 须指向该提供者下已启用的文本模型`,
        );
      }
    }
    return conflicts(() =>
      this.deps.aliases.save(map, versionOf(input.expectedVersion ?? null), actor),
    );
  }

  async impact(target: ImpactTarget): Promise<Impact> {
    await this.deps.ensureModels();
    if ("providerId" in target) await this.provider(target.providerId);
    else if (!(await this.deps.capabilities.get(target.capabilityId))) {
      throw new ModelAdminError(404, "not_found", "模型不存在");
    }
    const [rows, aliases, models] = await Promise.all([
      this.deps.agentRefs.list(),
      this.deps.aliases.get(),
      this.deps.capabilities.list(true),
    ]);
    return countImpact(rows, aliases, models, target);
  }
}
