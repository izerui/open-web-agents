import type { Agent, AgentRepo } from "@/lib/modules/agent/ports";

/** 内存智能体仓储。垂直切片先内置一个通用智能体,构建器与 MySQL adapter 后续接入。 */
export class InMemoryAgentRepo implements AgentRepo {
  private items = new Map<string, Agent>();

  constructor(seed: Agent[] = []) {
    for (const a of seed) this.items.set(a.id, a);
  }

  async get(id: string): Promise<Agent | null> {
    const a = this.items.get(id);
    return a ? structuredClone(a) : null;
  }

  async list(): Promise<Agent[]> {
    return [...this.items.values()].map((a) => structuredClone(a));
  }

  async upsert(a: Agent): Promise<Agent> {
    this.items.set(a.id, structuredClone(a));
    return structuredClone(a);
  }

  async delete(id: string): Promise<void> {
    this.items.delete(id);
  }
}
