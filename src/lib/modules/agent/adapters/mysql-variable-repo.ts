import type { Db } from "@/lib/db/client";
import { agentVariables } from "@/lib/db/schema";
import type { SecretBox } from "@/lib/modules/identity/domain/secret-box";
import { and, eq } from "drizzle-orm";

export interface VariableRepo {
  get(agentId: string, userId: string): Promise<Record<string, string>>;
  set(agentId: string, userId: string, values: Record<string, string>): Promise<void>;
  delete(agentId: string, userId: string): Promise<void>;
}

export class MysqlVariableRepo implements VariableRepo {
  constructor(
    private readonly db: Db,
    private readonly secrets: SecretBox,
  ) {}

  async get(agentId: string, userId: string): Promise<Record<string, string>> {
    const [row] = await this.db
      .select()
      .from(agentVariables)
      .where(and(eq(agentVariables.agentId, agentId), eq(agentVariables.userId, userId)))
      .limit(1);
    if (!row) return {};
    const plain = this.secrets.decrypt(row.valuesEnc);
    if (plain === null) return {};
    try {
      return JSON.parse(plain) as Record<string, string>;
    } catch {
      return {};
    }
  }

  async set(agentId: string, userId: string, values: Record<string, string>): Promise<void> {
    const enc = this.secrets.encrypt(JSON.stringify(values));
    const now = new Date();
    await this.db
      .insert(agentVariables)
      .values({ agentId, userId, valuesEnc: enc, updatedAt: now })
      .onDuplicateKeyUpdate({ set: { valuesEnc: enc, updatedAt: now } });
  }

  async delete(agentId: string, userId: string): Promise<void> {
    await this.db
      .delete(agentVariables)
      .where(and(eq(agentVariables.agentId, agentId), eq(agentVariables.userId, userId)));
  }
}
