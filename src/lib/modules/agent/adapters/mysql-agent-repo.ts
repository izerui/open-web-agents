import type { Db } from "@/lib/db/client";
import { agents } from "@/lib/db/schema";
import type { AgentConfig } from "@/lib/modules/agent/domain/config";
import type { Agent, AgentRepo } from "@/lib/modules/agent/ports";
import type { JsonSchema } from "@/lib/shared";
import { desc, eq } from "drizzle-orm";

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
    const rows = await this.db.select(COLUMNS).from(agents).where(eq(agents.id, id)).limit(1);
    const row = rows[0];
    return row ? toAgent(row) : null;
  }

  async list(): Promise<Agent[]> {
    const rows = await this.db
      .select(COLUMNS)
      .from(agents)
      .orderBy(desc(agents.updatedAt))
      .limit(200);
    return rows.map(toAgent);
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
      visibility: "private" as const,
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

  async delete(id: string): Promise<void> {
    await this.db.delete(agents).where(eq(agents.id, id));
  }
}
