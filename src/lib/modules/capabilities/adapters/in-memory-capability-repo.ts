import type { Capability, CapabilityDefinition } from "../domain/catalog";
import { validateCapability } from "../domain/catalog";
import { CapabilityConflict, type CapabilityRepo, type CapabilityVersion } from "../ports";

export class InMemoryCapabilityRepo implements CapabilityRepo {
  private readonly items = new Map<string, Capability>();
  private readonly versions = new Map<string, CapabilityVersion>();

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
    const saved = { ...definition, version: (current?.version ?? 0) + 1, updatedAt: Date.now() };
    this.items.set(saved.id, structuredClone(saved));
    this.versions.set(
      `${saved.id}:${saved.version}`,
      structuredClone({ ...saved, createdBy: actorId }),
    );
    return structuredClone(saved);
  }

  async version(id: string, version: number): Promise<CapabilityVersion | null> {
    return structuredClone(this.versions.get(`${id}:${version}`) ?? null);
  }
}
