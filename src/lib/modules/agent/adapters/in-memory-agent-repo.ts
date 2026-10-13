import type { Agent, AgentListFilter, AgentRepo } from "@/lib/modules/agent/ports";

/** 内存智能体仓储。垂直切片先内置一个通用智能体,构建器与 MySQL adapter 后续接入。 */
export class InMemoryAgentRepo implements AgentRepo {
  private items = new Map<string, Agent>();

  constructor(seed: Agent[] = []) {
    // 存副本:调用方传进来的种子对象不能被后续的发布指针等写入改掉
    for (const a of seed) this.items.set(a.id, structuredClone(a));
  }

  async get(id: string): Promise<Agent | null> {
    const a = this.items.get(id);
    return a ? structuredClone(a) : null;
  }

  async list(filter?: AgentListFilter): Promise<Agent[]> {
    const all = [...this.items.values()];
    const picked = filter
      ? all.filter(
          (a) =>
            (filter.ownerId !== undefined && a.ownerId === filter.ownerId) ||
            (filter.ids?.includes(a.id) ?? false),
        )
      : all;
    return picked.map((a) => structuredClone(a));
  }

  async countByOwner(): Promise<Map<string, number>> {
    const m = new Map<string, number>();
    for (const a of this.items.values()) m.set(a.ownerId, (m.get(a.ownerId) ?? 0) + 1);
    return m;
  }

  async upsert(a: Agent): Promise<Agent> {
    // 与 MySQL 实现一致:发布指针只由版本仓储维护,upsert 不动它
    const prev = this.items.get(a.id);
    const next: Agent = {
      ...structuredClone(a),
      publishedVersion: prev?.publishedVersion,
      publishedHash: prev?.publishedHash,
    };
    this.items.set(a.id, next);
    return structuredClone(next);
  }

  /** 仅供内存版本仓储调用。 */
  setPublished(id: string, version: number, hash: string): void {
    const a = this.items.get(id);
    if (!a) throw new Error(`agent not found: ${id}`);
    a.publishedVersion = version;
    a.publishedHash = hash;
  }

  async delete(id: string): Promise<void> {
    this.items.delete(id);
  }
}
