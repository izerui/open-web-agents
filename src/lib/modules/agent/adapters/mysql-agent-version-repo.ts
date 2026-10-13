import type { Db } from "@/lib/db/client";
import { agentVersions, agents } from "@/lib/db/schema";
import type { AgentConfig } from "@/lib/modules/agent/domain/config";
import type { AgentSnapshot, AgentVersion, AgentVersionRepo } from "@/lib/modules/agent/ports";
import { and, desc, eq, or, sql } from "drizzle-orm";

interface Row {
  agentId: string;
  version: number;
  name: string;
  icon: string | null;
  description: string | null;
  config: unknown;
  contentHash: string;
  note: string | null;
  createdBy: string;
  createdAt: Date;
}

const META = {
  agentId: agentVersions.agentId,
  version: agentVersions.version,
  name: agentVersions.name,
  icon: agentVersions.icon,
  description: agentVersions.description,
  contentHash: agentVersions.contentHash,
  note: agentVersions.note,
  createdBy: agentVersions.createdBy,
  createdAt: agentVersions.createdAt,
};

function toMeta(r: Omit<Row, "config">): Omit<AgentVersion, "config"> {
  return {
    agentId: r.agentId,
    version: r.version,
    name: r.name,
    icon: r.icon ?? undefined,
    description: r.description ?? undefined,
    contentHash: r.contentHash,
    note: r.note ?? undefined,
    createdBy: r.createdBy,
    createdAt: r.createdAt.getTime(),
  };
}

const toVersion = (r: Row): AgentVersion => ({ ...toMeta(r), config: r.config as AgentConfig });

export class MysqlAgentVersionRepo implements AgentVersionRepo {
  constructor(private readonly db: Db) {}

  async publish(
    agentId: string,
    snapshot: AgentSnapshot,
    meta: { contentHash: string; note?: string; createdBy: string },
  ): Promise<AgentVersion> {
    const version = await this.db.transaction(async (tx) => {
      // 锁住智能体这一行:同一智能体的并发发布在这里排队,版本号不会撞,
      // 指针也只会指向各自刚插入的那一版
      const locked = await tx.execute(
        sql`SELECT id FROM agents WHERE id = ${agentId} LIMIT 1 FOR UPDATE`,
      );
      const lockedRows = (locked as unknown as [unknown[]])[0];
      if (!Array.isArray(lockedRows) || lockedRows.length === 0) {
        throw new Error(`agent not found: ${agentId}`);
      }
      const [max] = await tx
        .select({ v: sql<number | null>`MAX(${agentVersions.version})` })
        .from(agentVersions)
        .where(eq(agentVersions.agentId, agentId));
      const next = Number(max?.v ?? 0) + 1;
      await tx.insert(agentVersions).values({
        agentId,
        version: next,
        name: snapshot.name,
        icon: snapshot.icon ?? null,
        description: snapshot.description ?? null,
        config: snapshot.config,
        contentHash: meta.contentHash,
        note: meta.note ?? null,
        createdBy: meta.createdBy,
      });
      await tx
        .update(agents)
        .set({ publishedVersion: next, publishedHash: meta.contentHash })
        .where(eq(agents.id, agentId));
      return next;
    });
    const saved = await this.get(agentId, version);
    if (!saved) throw new Error(`publish failed: ${agentId}@${version}`);
    return saved;
  }

  async get(agentId: string, version: number): Promise<AgentVersion | null> {
    const rows = await this.db
      .select({ ...META, config: agentVersions.config })
      .from(agentVersions)
      .where(and(eq(agentVersions.agentId, agentId), eq(agentVersions.version, version)))
      .limit(1);
    return rows[0] ? toVersion(rows[0]) : null;
  }

  async list(agentId: string): Promise<Omit<AgentVersion, "config">[]> {
    const rows = await this.db
      .select(META)
      .from(agentVersions)
      .where(eq(agentVersions.agentId, agentId))
      .orderBy(desc(agentVersions.version))
      .limit(200);
    return rows.map(toMeta);
  }

  async getMany(keys: { agentId: string; version: number }[]): Promise<AgentVersion[]> {
    if (keys.length === 0) return [];
    const rows = await this.db
      .select({ ...META, config: agentVersions.config })
      .from(agentVersions)
      .where(
        or(
          ...keys.map((k) =>
            and(eq(agentVersions.agentId, k.agentId), eq(agentVersions.version, k.version)),
          ),
        ),
      );
    return rows.map(toVersion);
  }

  async activate(agentId: string, version: number, contentHash: string): Promise<void> {
    const res = await this.db
      .update(agents)
      .set({ publishedVersion: version, publishedHash: contentHash })
      .where(
        and(
          eq(agents.id, agentId),
          // 只能指向确实存在的版本 —— 在同一条 UPDATE 里判定,不留先查后写的窗口
          sql`EXISTS (SELECT 1 FROM agent_versions av WHERE av.agent_id = ${agentId} AND av.version = ${version})`,
        ),
      );
    const affected = (res as unknown as [{ affectedRows: number }])[0]?.affectedRows ?? 0;
    if (affected === 0) throw new Error(`version not found: ${agentId}@${version}`);
  }
}
