import {
  type ModelAliasMap,
  type ModelAliases,
  type Provider,
  type ProviderDefinition,
  validateAliasMap,
  validateProvider,
} from "../domain/provider";
import {
  type BootstrapMarker,
  type ModelAliasRepo,
  ProviderConflict,
  type ProviderRepo,
} from "../ports";

interface Row extends Provider {
  keyEnc: string | null;
}

export class InMemoryProviderRepo implements ProviderRepo {
  private readonly rows = new Map<string, Row>();

  private view({ keyEnc: _, ...p }: Row): Provider {
    return structuredClone(p);
  }

  async list(): Promise<Provider[]> {
    return [...this.rows.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((r) => this.view(r));
  }

  async get(id: string): Promise<Provider | null> {
    const row = this.rows.get(id);
    return row ? this.view(row) : null;
  }

  async save(
    raw: ProviderDefinition,
    expectedVersion: number | null,
    _actorId: string,
  ): Promise<Provider> {
    const def = validateProvider(raw);
    const current = this.rows.get(def.id);
    if ((current?.version ?? null) !== expectedVersion) throw new ProviderConflict();
    for (const other of this.rows.values()) {
      if (other.id !== def.id && other.name === def.name) {
        throw new ProviderConflict("名称已被其他提供者使用");
      }
    }
    const row: Row = {
      ...def,
      hasKey: current?.hasKey ?? false,
      keyHint: current?.keyHint ?? null,
      keyEnc: current?.keyEnc ?? null,
      version: (current?.version ?? 0) + 1,
      updatedAt: Date.now(),
    };
    this.rows.set(def.id, structuredClone(row));
    return this.view(row);
  }

  async setKey(id: string, keyEnc: string, keyHint: string): Promise<void> {
    const row = this.rows.get(id);
    if (!row) throw new Error("提供者不存在");
    this.rows.set(id, { ...row, keyEnc, keyHint, hasKey: true, updatedAt: Date.now() });
  }

  async keyEnc(id: string): Promise<string | null> {
    return this.rows.get(id)?.keyEnc ?? null;
  }
}

export class InMemoryModelAliasRepo implements ModelAliasRepo {
  private current: ModelAliases | null = null;

  async get(): Promise<ModelAliases | null> {
    return structuredClone(this.current);
  }

  async save(raw: ModelAliasMap, expectedVersion: number | null): Promise<ModelAliases> {
    const map = validateAliasMap(raw);
    if ((this.current?.version ?? null) !== expectedVersion) {
      throw new ProviderConflict("别名映射已变化,请刷新后重试");
    }
    this.current = { ...map, version: (this.current?.version ?? 0) + 1, updatedAt: Date.now() };
    return structuredClone(this.current);
  }
}

export class InMemoryBootstrapMarker implements BootstrapMarker {
  private readonly done = new Set<string>();

  async isDone(key: string): Promise<boolean> {
    return this.done.has(key);
  }

  async markDone(key: string): Promise<void> {
    this.done.add(key);
  }
}
