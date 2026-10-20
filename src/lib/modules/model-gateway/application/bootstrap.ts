// 升级后免配置:把环境变量里的模型接入(OWA_ANTHROPIC_* / OWA_MODEL_*)收编为"平台默认"提供者。
//
// 【为什么在启动时做而不是写进 SQL 迁移】Key 要用 SecretBox 加密,SQL 里做不到。
// 【为什么完成标记写在最后】先抢标记的话,中途崩溃就再也不会补做。这里每一步都可重复执行,
// web 与 worker 并发启动时由各仓库的版本冲突保证只生效一次;全部成功才写标记,之后只补 Key。
import { type CapabilityDefinition, RESERVED_IDS } from "@/lib/modules/capabilities/domain/catalog";
import { STANDARD_METERS } from "@/lib/modules/capabilities/domain/pricing";
import {
  CapabilityConflict,
  type CapabilityRepo,
  DuplicateModelId,
} from "@/lib/modules/capabilities/ports";
import { MODEL_ALIASES, type ModelAlias } from "@/lib/shared";
import { DEFAULT_PROVIDER_ID } from "../domain/provider";
import {
  type BootstrapMarker,
  type ModelAliasRepo,
  type ModelSlots,
  ProviderConflict,
  type ProviderRepo,
} from "../ports";

export const BOOTSTRAP_KEY = "model_providers_bootstrap_v1";
const SYSTEM_ACTOR = "system";

/** 官方模型 id 的展示名;其他 id 直接用 id 作名称,管理员可改。 */
const OFFICIAL_NAMES: Record<string, string> = {
  "claude-fable-5-1": "Claude Fable 5.1",
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
};

export interface BootstrapDeps {
  providers: ProviderRepo;
  aliases: ModelAliasRepo;
  capabilities: CapabilityRepo;
  marker: BootstrapMarker;
  encrypt: (plain: string) => string;
  mask: (plain: string) => string;
  env: { baseUrl: string; apiKey: string; slots: ModelSlots };
  warn?: (message: string) => void;
}

const isConflict = (err: unknown) =>
  err instanceof ProviderConflict || err instanceof CapabilityConflict;

export async function bootstrapProviders(deps: BootstrapDeps): Promise<void> {
  if (!(await deps.marker.isDone(BOOTSTRAP_KEY))) {
    await ensureDefaultProvider(deps);
    await adoptLegacyModels(deps);
    const slotModels = await ensureSlotModels(deps);
    await ensureAliases(deps, slotModels);
    await deps.marker.markDone(BOOTSTRAP_KEY);
  }
  await backfillKey(deps);
}

async function ensureDefaultProvider(deps: BootstrapDeps): Promise<void> {
  if (await deps.providers.get(DEFAULT_PROVIDER_ID)) return;
  try {
    await deps.providers.save(
      {
        id: DEFAULT_PROVIDER_ID,
        name: "平台默认",
        enabled: true,
        endpoints: { llm: { protocol: "anthropic", baseUrl: deps.env.baseUrl } },
      },
      null,
      SYSTEM_ACTOR,
    );
  } catch (err) {
    if (!isConflict(err)) throw err;
  }
}

/**
 * 旧价目直接以积分录入:收编时成本 = 现售价、加价 0,派生出的售价与原值逐项相同,
 * 用户被扣的积分不变。同一模型标识出现多次的文本模型只收编第一个启用的,其余停用后留待管理员处理。
 */
async function adoptLegacyModels(deps: BootstrapDeps): Promise<void> {
  const all = await deps.capabilities.list(true);
  const ordered = [...all].sort((a, b) => Number(b.enabled) - Number(a.enabled));
  for (const cap of ordered) {
    if (cap.providerId || cap.replacedBy) continue;
    const { version, updatedAt: _, ...def } = cap;
    const adopted: CapabilityDefinition = {
      ...def,
      providerId: DEFAULT_PROVIDER_ID,
      markupBp: def.markupBp ?? 0,
      costRates: def.costRates ?? def.rates,
    };
    if (RESERVED_IDS.has(cap.id)) {
      await replaceReservedId(deps, cap.id, adopted);
      continue;
    }
    try {
      await deps.capabilities.save(adopted, version, SYSTEM_ACTOR);
    } catch (err) {
      if (isConflict(err)) continue;
      if (!(err instanceof DuplicateModelId)) throw err;
      deps.warn?.(`模型「${cap.id}」与已收编模型标识重复,保持未归属并停用,请管理员处理`);
      if (cap.enabled) {
        await deps.capabilities
          .save({ ...def, enabled: false }, version, SYSTEM_ACTOR)
          .catch((e) => {
            if (!isConflict(e)) throw e;
          });
      }
    }
  }
}

/**
 * 旧版允许模型 ID 叫 fable/opus/sonnet/haiku,新版它们是智能体配置里的别名,不能再当模型 ID。
 * 按旧定义新建 legacy-<旧ID>(扣费不变),旧记录停用并记下替代者,历史价目版本原样保留。
 * 同一模型标识已有收编好的模型时,旧记录直接指向它。中途中断后重跑会复用已建好的那条。
 */
async function replaceReservedId(
  deps: BootstrapDeps,
  oldId: string,
  adopted: CapabilityDefinition,
): Promise<void> {
  const models = await deps.capabilities.list(true);
  const sameModel = (c: (typeof models)[number]) =>
    c.providerId === DEFAULT_PROVIDER_ID &&
    c.kind === adopted.kind &&
    c.modelId === adopted.modelId;
  const taken = new Set(models.map((c) => c.id));
  const base = `legacy-${oldId}`;
  let newId = base;
  for (let n = 2; taken.has(newId); n++) {
    const existing = models.find((c) => c.id === newId);
    if (existing && sameModel(existing)) break; // 上次中断时已建好
    newId = `${base}-${n}`;
  }
  let target = newId;
  if (!models.some((c) => c.id === newId)) {
    try {
      await deps.capabilities.save({ ...adopted, id: newId }, null, SYSTEM_ACTOR);
    } catch (err) {
      if (err instanceof DuplicateModelId) {
        // 同一提供者下同一标识的文本模型只能有一个:旧记录改为指向已收编的那条
        const twin = (await deps.capabilities.list(true)).find(sameModel);
        if (!twin) throw err;
        target = twin.id;
        deps.warn?.(`模型「${oldId}」与已收编模型「${twin.id}」标识重复,已停用并指向它`);
      } else if (!isConflict(err)) {
        throw err;
      }
    }
  }
  await deps.capabilities.retire(oldId, target, SYSTEM_ACTOR);
}

function slugFor(modelId: string, taken: Set<string>): string {
  const base = `default-${modelId.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}`
    .slice(0, 60)
    .replace(/-+$/, "");
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** 别名槽用到的模型标识 → 平台默认下的模型 id。缺的新建,成本价明确为 0(阶段 0 不计价)。 */
async function ensureSlotModels(deps: BootstrapDeps): Promise<Map<string, string>> {
  const byModelId = new Map<string, string>();
  const taken = new Set<string>();
  for (const cap of await deps.capabilities.list(true)) {
    taken.add(cap.id);
    if (cap.providerId === DEFAULT_PROVIDER_ID && cap.kind === "llm") {
      byModelId.set(cap.modelId, cap.id);
    }
  }
  for (const modelId of new Set(Object.values(deps.env.slots))) {
    if (byModelId.has(modelId)) continue;
    const id = slugFor(modelId, taken);
    try {
      await deps.capabilities.save(
        {
          id,
          name: OFFICIAL_NAMES[modelId] ?? modelId,
          kind: "llm",
          modelId,
          enabled: true,
          acceptsImages: false,
          providerId: DEFAULT_PROVIDER_ID,
          markupBp: 0,
          costRates: STANDARD_METERS.llm.map((m) => ({
            meter: m.meter,
            units: m.units,
            microCredits: "0",
          })),
          rates: [],
        },
        null,
        SYSTEM_ACTOR,
      );
      byModelId.set(modelId, id);
    } catch (err) {
      // 另一个进程刚建了它:重新读出它的 id
      if (!isConflict(err) && !(err instanceof DuplicateModelId)) throw err;
      const existing = (await deps.capabilities.list(true)).find(
        (c) => c.providerId === DEFAULT_PROVIDER_ID && c.kind === "llm" && c.modelId === modelId,
      );
      if (!existing) throw err;
      byModelId.set(modelId, existing.id);
    }
    taken.add(id);
  }
  return byModelId;
}

async function ensureAliases(deps: BootstrapDeps, slotModels: Map<string, string>): Promise<void> {
  if (await deps.aliases.get()) return;
  const targets = {} as Record<ModelAlias, string>;
  for (const alias of MODEL_ALIASES) {
    const id = slotModels.get(deps.env.slots[alias]);
    if (!id) throw new Error(`别名 ${alias} 对应的模型未能创建`);
    targets[alias] = id;
  }
  try {
    await deps.aliases.save({ providerId: DEFAULT_PROVIDER_ID, ...targets }, null, SYSTEM_ACTOR);
  } catch (err) {
    if (!isConflict(err)) throw err;
  }
}

/** 兼容"先启动、后补 .env":平台默认还没有 Key 而环境变量里有,就补写一次。 */
async function backfillKey(deps: BootstrapDeps): Promise<void> {
  const key = deps.env.apiKey.trim();
  if (!key) return;
  const provider = await deps.providers.get(DEFAULT_PROVIDER_ID);
  if (!provider || provider.hasKey) return;
  await deps.providers.setKey(DEFAULT_PROVIDER_ID, deps.encrypt(key), deps.mask(key), SYSTEM_ACTOR);
}
