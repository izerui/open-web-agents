import type { InMemoryAgentRepo } from "@/lib/modules/agent/adapters/in-memory-agent-repo";
import type { AgentSnapshot, AgentVersion, AgentVersionRepo } from "@/lib/modules/agent/ports";

/** 内存版本仓储:测试用。发布指针写回同一个内存智能体仓储。 */
export class InMemoryAgentVersionRepo implements AgentVersionRepo {
  private items = new Map<string, AgentVersion[]>();

  constructor(private readonly agents: InMemoryAgentRepo) {}

  async publish(
    agentId: string,
    snapshot: AgentSnapshot,
    meta: { contentHash: string; note?: string; createdBy: string },
  ): Promise<AgentVersion> {
    if (!(await this.agents.get(agentId))) throw new Error(`agent not found: ${agentId}`);
    const list = this.items.get(agentId) ?? [];
    const v: AgentVersion = {
      ...structuredClone(snapshot),
      agentId,
      version: list.length + 1,
      contentHash: meta.contentHash,
      note: meta.note,
      createdBy: meta.createdBy,
      createdAt: Date.now(),
    };
    list.push(v);
    this.items.set(agentId, list);
    this.agents.setPublished(agentId, v.version, v.contentHash);
    return structuredClone(v);
  }

  async get(agentId: string, version: number): Promise<AgentVersion | null> {
    const v = this.items.get(agentId)?.find((x) => x.version === version);
    return v ? structuredClone(v) : null;
  }

  async list(agentId: string): Promise<Omit<AgentVersion, "config">[]> {
    return [...(this.items.get(agentId) ?? [])]
      .sort((a, b) => b.version - a.version)
      .map(({ config: _c, ...rest }) => structuredClone(rest));
  }

  async getMany(keys: { agentId: string; version: number }[]): Promise<AgentVersion[]> {
    const out: AgentVersion[] = [];
    for (const k of keys) {
      const v = await this.get(k.agentId, k.version);
      if (v) out.push(v);
    }
    return out;
  }

  async activate(agentId: string, version: number, contentHash: string): Promise<void> {
    if (!(await this.get(agentId, version))) throw new Error(`version not found: ${version}`);
    this.agents.setPublished(agentId, version, contentHash);
  }
}
