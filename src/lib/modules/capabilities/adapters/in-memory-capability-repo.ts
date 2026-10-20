import type { Capability, CapabilityDefinition } from "../domain/catalog";
import { validateCapability } from "../domain/catalog";
import {
  CapabilityConflict,
  type CapabilityRepo,
  type CapabilityVersion,
  DuplicateModelId,
} from "../ports";

export class InMemoryCapabilityRepo implements CapabilityRepo {
  private readonly items = new Map<string, Capability>();
  private readonly versions = new Map<string, CapabilityVersion>();

  /** 种子数据不经校验,用来模拟旧版本写入、按新规则已不合法的记录 */
  constructor(seed: Capability[] = []) {
    for (const c of seed) {
      this.items.set(c.id, structuredClone(c));
      this.versions.set(`${c.id}:${c.version}`, structuredClone({ ...c, createdBy: "legacy" }));
    }
  }

  async get(id: string): Promise<Capability | null> {
    return structuredClone(this.items.get(id) ?? null);
  }

  async list(includeDisabled = false): Promise<Capability[]> {
    return [...this.items.values()]
      .filter((item) => includeDisabled || item.enabled)
      .map((item) => structuredClone(item));
  }

  async save(
    raw: CapabilityDefinition,
    expectedVersion: number | null,
    actorId: string,
  ): Promise<Capability> {
    const definition = validateCapability(raw);
    const current = this.items.get(definition.id);
    if ((current?.version ?? null) !== expectedVersion) throw new CapabilityConflict();
    if (definition.providerId && definition.kind === "llm") {
      for (const other of this.items.values()) {
        if (
          other.id !== definition.id &&
          other.providerId === definition.providerId &&
          other.kind === "llm" &&
          other.modelId === definition.modelId
        ) {
          throw new DuplicateModelId(definition.modelId);
        }
      }
    }
    const saved = { ...definition, version: (current?.version ?? 0) + 1, updatedAt: Date.now() };
    this.items.set(saved.id, structuredClone(saved));
    this.versions.set(
      `${saved.id}:${saved.version}`,
      structuredClone({ ...saved, createdBy: actorId }),
    );
    return structuredClone(saved);
  }

  async retire(id: string, replacedBy: string, actorId: string): Promise<void> {
    const current = this.items.get(id);
    if (!current || current.replacedBy) return;
    const next = {
      ...current,
      enabled: false,
      replacedBy,
      version: current.version + 1,
      updatedAt: Date.now(),
    };
    this.items.set(id, structuredClone(next));
    this.versions.set(`${id}:${next.version}`, structuredClone({ ...next, createdBy: actorId }));
  }

  async version(id: string, version: number): Promise<CapabilityVersion | null> {
    return structuredClone(this.versions.get(`${id}:${version}`) ?? null);
  }
}
