import type { Db } from "@/lib/db/client";
import { agents } from "@/lib/db/schema";
import type { AgentConfig } from "@/lib/modules/agent/domain/config";
import type { Agent, AgentRepo } from "@/lib/modules/agent/ports";
import type { AgentListFilter } from "@/lib/modules/agent/ports";
import type { JsonSchema } from "@/lib/shared";
import { type SQL, and, count, desc, eq, inArray, isNull, or } from "drizzle-orm";

interface Row {
  id: string;
  ownerId: string;
  name: string;
  icon: string | null;
  description: string | null;
  config: unknown;
  inputSchema: unknown;
  outputSchema: unknown;
  webhookUrl: string | null;
  publishedVersion: number | null;
  publishedHash: string | null;
  seedHash: string | null;
}

const COLUMNS = {
  id: agents.id,
  ownerId: agents.ownerId,
  name: agents.name,
  icon: agents.icon,
  description: agents.description,
  config: agents.config,
  inputSchema: agents.inputSchema,
  outputSchema: agents.outputSchema,
  webhookUrl: agents.webhookUrl,
  publishedVersion: agents.publishedVersion,
  publishedHash: agents.publishedHash,
  seedHash: agents.seedHash,
};

function toAgent(r: Row): Agent {
  const config = r.config as AgentConfig;
  return {
    id: r.id,
    ownerId: r.ownerId,
    name: r.name,
    icon: r.icon ?? undefined,
    description: r.description ?? undefined,
    webhookUrl: r.webhookUrl ?? undefined,
    publishedVersion: r.publishedVersion ?? undefined,
    publishedHash: r.publishedHash ?? undefined,
    seedHash: r.seedHash ?? undefined,
    // 两个 schema 都单列存储(要按它们做接口契约查询/展示),回填进 config 供上层使用。
    // input_schema 这一列建表时就有,但此前【从没被读写过】—— 一个死列配一句谎话注释。
    config: {
      ...config,
      inputSchema: (r.inputSchema as JsonSchema | null) ?? undefined,
      outputSchema: (r.outputSchema as JsonSchema | null) ?? undefined,
    },
  };
}

export class MysqlAgentRepo implements AgentRepo {
  constructor(
    private readonly db: Db,
    /** 单用户 MVP 的默认 owner;identity 模块接入后由调用方传入。 */
    private readonly defaultOwnerId = "system",
  ) {}

  async get(id: string): Promise<Agent | null> {
    const rows = await this.db
      .select(COLUMNS)
      .from(agents)
      .where(and(eq(agents.id, id), isNull(agents.deletedAt)))
      .limit(1);
    const row = rows[0];
    return row ? toAgent(row) : null;
  }

  async list(filter?: AgentListFilter): Promise<Agent[]> {
    if (!filter) {
      const rows = await this.db
        .select(COLUMNS)
        .from(agents)
        .where(isNull(agents.deletedAt))
        .orderBy(desc(agents.updatedAt))
        .limit(200);
      return rows.map(toAgent);
    }
    const conds: SQL[] = [];
    if (filter.ownerId !== undefined) conds.push(eq(agents.ownerId, filter.ownerId));
    if (filter.ids?.length) conds.push(inArray(agents.id, filter.ids));
    if (conds.length === 0) return [];
    const rows = await this.db
      .select(COLUMNS)
      .from(agents)
      .where(and(or(...conds), isNull(agents.deletedAt)))
      .orderBy(desc(agents.updatedAt))
      // 已按可见范围过滤,这里的上限只是防呆,不再会把别人的智能体挤出去
      .limit(1000);
    return rows.map(toAgent);
  }

  async countByOwner(): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ ownerId: agents.ownerId, n: count() })
      .from(agents)
      .where(isNull(agents.deletedAt))
      .groupBy(agents.ownerId);
    return new Map(rows.map((r) => [r.ownerId, Number(r.n)]));
  }

  async upsert(a: Agent): Promise<Agent> {
    const { inputSchema, outputSchema, ...restConfig } = a.config;
    const values = {
      id: a.id,
      ownerId: a.ownerId || this.defaultOwnerId,
      name: a.name,
      icon: a.icon,
      description: a.description,
      config: restConfig,
      inputSchema: inputSchema ?? null,
      outputSchema: outputSchema ?? null,
      webhookUrl: a.webhookUrl ?? null,
    };
    await this.db
      .insert(agents)
      .values(values)
      .onDuplicateKeyUpdate({
        set: {
          name: values.name,
          icon: values.icon,
          description: values.description,
          config: values.config,
          inputSchema: values.inputSchema,
          outputSchema: values.outputSchema,
          webhookUrl: values.webhookUrl,
        },
      });
    const saved = await this.get(a.id);
    if (!saved) throw new Error(`agent upsert failed: ${a.id}`);
    return saved;
  }

  async setSeedHash(id: string, hash: string): Promise<void> {
    await this.db.update(agents).set({ seedHash: hash }).where(eq(agents.id, id));
  }

  async softDelete(id: string, at: number): Promise<boolean> {
    const res = await this.db
      .update(agents)
      .set({ deletedAt: at })
      .where(and(eq(agents.id, id), isNull(agents.deletedAt)));
    return ((res as unknown as [{ affectedRows: number }])[0]?.affectedRows ?? 0) > 0;
  }

  async idTaken(id: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, id))
      .limit(1);
    return rows.length > 0;
  }
}
