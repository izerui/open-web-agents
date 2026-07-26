import type { Db } from "@/lib/db/client";
import { assistants } from "@/lib/db/schema";
import type { AssistantConfig } from "@/lib/modules/assistant/domain/config";
import type { Assistant, AssistantRepo } from "@/lib/modules/assistant/ports";
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
  id: assistants.id,
  ownerId: assistants.ownerId,
  name: assistants.name,
  icon: assistants.icon,
  description: assistants.description,
  config: assistants.config,
  inputSchema: assistants.inputSchema,
  outputSchema: assistants.outputSchema,
  webhookUrl: assistants.webhookUrl,
};

function toAssistant(r: Row): Assistant {
  const config = r.config as AssistantConfig;
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

export class MysqlAssistantRepo implements AssistantRepo {
  constructor(
    private readonly db: Db,
    /** 单用户 MVP 的默认 owner;identity 模块接入后由调用方传入。 */
    private readonly defaultOwnerId = "system",
  ) {}

  async get(id: string): Promise<Assistant | null> {
    const rows = await this.db
      .select(COLUMNS)
      .from(assistants)
      .where(eq(assistants.id, id))
      .limit(1);
    const row = rows[0];
    return row ? toAssistant(row) : null;
  }

  async list(): Promise<Assistant[]> {
    const rows = await this.db
      .select(COLUMNS)
      .from(assistants)
      .orderBy(desc(assistants.updatedAt))
      .limit(200);
    return rows.map(toAssistant);
  }

  async upsert(a: Assistant): Promise<Assistant> {
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
      .insert(assistants)
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
    if (!saved) throw new Error(`assistant upsert failed: ${a.id}`);
    return saved;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(assistants).where(eq(assistants.id, id));
  }
}
