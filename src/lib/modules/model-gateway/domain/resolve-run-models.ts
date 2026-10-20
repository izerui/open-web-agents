// 一次运行用哪个提供者、哪些真实模型。纯函数。
//
// 一次运行 = 一个 SDK 进程 = 一套 Base URL 与 Key,所以主模型、子代理、SDK 按别名发起的辅助调用
// 必须落在同一个提供者内。面向用户的提示不暴露提供者。
import type { Capability } from "@/lib/modules/capabilities/domain/catalog";
import {
  BrandedError,
  MODEL_ALIASES,
  type ModelAlias,
  type ModelRef,
  type RunPricing,
  isModelAlias,
} from "@/lib/shared";
import type { ModelAliases, Provider } from "./provider";

export type ModelUnavailableCode =
  | "model_not_found"
  | "model_disabled"
  | "cross_provider"
  | "not_configured";

export class ModelUnavailable extends BrandedError {
  static readonly brand = Symbol.for("owa.error.ModelUnavailable");
  constructor(
    readonly code: ModelUnavailableCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ResolveRunModelsInput {
  main: ModelRef;
  /** 调用方覆盖主模型(设计会话不传) */
  override?: ModelRef;
  subagents?: { name: string; model?: ModelRef }[];
  models: Capability[];
  providers: Provider[];
  aliases: ModelAliases | null;
}

export interface ResolvedModel {
  ref: ModelRef;
  capabilityId: string;
  modelId: string;
  name: string;
  version: number;
}

export interface RunModelBinding {
  providerId: string;
  baseUrl: string;
  main: ResolvedModel;
  /** 子代理名 → 模型;没配模型的子代理不在表里(跟主模型一样) */
  subagents: Record<string, ResolvedModel>;
  slots: Record<ModelAlias, string>;
  pricing: RunPricing;
}

const NOT_CONFIGURED = "平台尚未完成模型配置,请联系管理员";

export function resolveRunModels(input: ResolveRunModelsInput): RunModelBinding {
  const byId = new Map(input.models.map((m) => [m.id, m]));
  const providers = new Map(input.providers.map((p) => [p.id, p]));

  const lookup = (ref: ModelRef): Capability | undefined => {
    const id = isModelAlias(ref) ? input.aliases?.[ref] : ref;
    return id ? byId.get(id) : undefined;
  };
  const usable = (m: Capability | undefined): boolean =>
    !!m && m.kind === "llm" && m.enabled && providers.get(m.providerId ?? "")?.enabled === true;
  const toResolved = (ref: ModelRef, m: Capability): ResolvedModel => ({
    ref,
    capabilityId: m.id,
    modelId: m.modelId,
    name: m.name,
    version: m.version,
  });

  const mainRef = input.override ?? input.main;
  const main = lookup(mainRef);
  if (!main || main.kind !== "llm") {
    // 别名指向的模型缺失是平台配置问题,不是作者的问题
    if (isModelAlias(mainRef)) throw new ModelUnavailable("not_configured", NOT_CONFIGURED);
    throw new ModelUnavailable("model_not_found", "智能体使用的模型不存在,请联系作者更换模型");
  }
  if (!usable(main)) {
    throw new ModelUnavailable(
      "model_disabled",
      `智能体使用的模型「${main.name}」已停用,请联系作者更换模型`,
    );
  }
  const provider = providers.get(main.providerId ?? "") as Provider;
  const baseUrl = provider.endpoints.llm?.baseUrl;
  if (!baseUrl || !provider.hasKey) throw new ModelUnavailable("not_configured", NOT_CONFIGURED);

  const subagents: Record<string, ResolvedModel> = {};
  for (const s of input.subagents ?? []) {
    if (!s.model) continue;
    const m = lookup(s.model);
    if (!m || m.kind !== "llm") {
      throw new ModelUnavailable(
        "model_not_found",
        `子代理「${s.name}」使用的模型不存在,请联系作者更换模型`,
      );
    }
    if (!usable(m)) {
      throw new ModelUnavailable(
        "model_disabled",
        `子代理「${s.name}」使用的模型「${m.name}」已停用,请联系作者更换模型`,
      );
    }
    if (m.providerId !== provider.id) {
      throw new ModelUnavailable(
        "cross_provider",
        `子代理「${s.name}」的模型不能与主模型同时使用,请在构建器中调整`,
      );
    }
    subagents[s.name] = toResolved(s.model, m);
  }

  // 别名槽:映射到的模型可用且属于本提供者就用它,否则用主模型 —— 保证 SDK 的辅助调用不越出本提供者
  const slots = {} as Record<ModelAlias, string>;
  const slotIds = {} as Record<ModelAlias, string | null>;
  const slotModels: Capability[] = [];
  for (const alias of MODEL_ALIASES) {
    const target = lookup(alias);
    if (target && usable(target) && target.providerId === provider.id) {
      slots[alias] = target.modelId;
      slotIds[alias] = target.id;
      slotModels.push(target);
    } else {
      slots[alias] = main.modelId;
      slotIds[alias] = null;
    }
  }

  const priced = new Map<string, { capabilityId: string; modelId: string; version: number }>();
  for (const m of [
    main,
    ...Object.values(subagents).map((r) => byId.get(r.capabilityId) as Capability),
    ...slotModels,
  ]) {
    priced.set(m.id, { capabilityId: m.id, modelId: m.modelId, version: m.version });
  }

  return {
    providerId: provider.id,
    baseUrl,
    main: toResolved(mainRef, main),
    subagents,
    slots,
    pricing: {
      providerId: provider.id,
      models: [...priced.values()],
      binding: {
        mainRef,
        main: main.id,
        subagents: Object.fromEntries(
          Object.entries(subagents).map(([name, r]) => [name, { ref: r.ref, id: r.capabilityId }]),
        ),
        slots: slotIds,
      },
    },
  };
}

export interface ResolvePinnedInput {
  pricing: RunPricing & { binding: NonNullable<RunPricing["binding"]> };
  /** 当前目录:只用来判断模型此刻是否仍启用 */
  models: Capability[];
  providers: Provider[];
  /** 锁定的价目版本快照(按 capabilityId) */
  versions: Map<string, Capability>;
}

/**
 * 按受理时锁定的绑定解析:模型标识与价格取锁定版本,但模型或提供者此刻已停用仍然不跑 ——
 * 排队期间被停用的模型不该再被调用。
 */
export function resolvePinnedModels(input: ResolvePinnedInput): RunModelBinding {
  const { binding } = input.pricing;
  const current = new Map(input.models.map((m) => [m.id, m]));
  const provider = input.providers.find((p) => p.id === input.pricing.providerId);
  const pinned = (id: string): Capability => {
    const snap = input.versions.get(id);
    const now = current.get(id);
    if (!snap || !now) {
      throw new ModelUnavailable("model_not_found", "智能体使用的模型不存在,请联系作者更换模型");
    }
    if (!now.enabled || now.kind !== "llm" || !provider?.enabled) {
      throw new ModelUnavailable(
        "model_disabled",
        `智能体使用的模型「${now.name}」已停用,请联系作者更换模型`,
      );
    }
    return snap;
  };
  const main = pinned(binding.main);
  const baseUrl = provider?.endpoints.llm?.baseUrl;
  if (!provider || !baseUrl || !provider.hasKey) {
    throw new ModelUnavailable("not_configured", NOT_CONFIGURED);
  }
  const resolved = (ref: ModelRef, m: Capability): ResolvedModel => ({
    ref,
    capabilityId: m.id,
    modelId: m.modelId,
    name: m.name,
    version: m.version,
  });
  const subagents: Record<string, ResolvedModel> = {};
  for (const [name, s] of Object.entries(binding.subagents)) {
    subagents[name] = resolved(s.ref, pinned(s.id));
  }
  const slots = {} as Record<ModelAlias, string>;
  for (const alias of MODEL_ALIASES) {
    const id = binding.slots[alias];
    // 别名槽只服务 SDK 的辅助调用:锁定的模型此刻停用就退回主模型,不让整次运行失败
    const snap = id ? input.versions.get(id) : undefined;
    const now = id ? current.get(id) : undefined;
    slots[alias] = snap && now?.enabled ? snap.modelId : main.modelId;
  }
  return {
    providerId: provider.id,
    baseUrl,
    main: resolved(binding.mainRef, main),
    subagents,
    slots,
    pricing: input.pricing,
  };
}
