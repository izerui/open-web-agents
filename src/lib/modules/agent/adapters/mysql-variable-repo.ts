import type { Db } from "@/lib/db/client";
import { agentVariables } from "@/lib/db/schema";
import type { SecretBox } from "@/lib/modules/identity/domain/secret-box";
import { and, eq } from "drizzle-orm";

export interface VariableRepo {
  get(agentId: string, userId: string): Promise<Record<string, string>>;
  set(agentId: string, userId: string, values: Record<string, string>): Promise<void>;
  merge(
    agentId: string,
    userId: string,
    updates: Record<string, string | null>,
  ): Promise<Record<string, string>>;
  delete(agentId: string, userId: string): Promise<void>;
}

export class VariableSizeExceeded extends Error {
  constructor() {
    super("变量总数据量不能超过 500KB");
    this.name = "VariableSizeExceeded";
  }
}

export class VariableDecryptionFailed extends Error {
  constructor() {
    super("变量值解密失败，可能主密钥已变更，请联系管理员");
    this.name = "VariableDecryptionFailed";
  }
}

const MAX_TOTAL_SIZE = 500_000;

export class MysqlVariableRepo implements VariableRepo {
  constructor(
    private readonly db: Db,
    private readonly secrets: SecretBox,
  ) {}

  private decryptSafe(enc: string): Record<string, string> {
    const plain = this.secrets.decrypt(enc);
    if (plain === null) return {};
    try {
      return JSON.parse(plain) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private decryptStrict(enc: string): Record<string, string> {
    const plain = this.secrets.decrypt(enc);
    if (plain === null) throw new VariableDecryptionFailed();
    try {
      return JSON.parse(plain) as Record<string, string>;
    } catch {
      throw new VariableDecryptionFailed();
    }
  }

  async get(agentId: string, userId: string): Promise<Record<string, string>> {
    const [row] = await this.db
      .select()
      .from(agentVariables)
      .where(and(eq(agentVariables.agentId, agentId), eq(agentVariables.userId, userId)))
      .limit(1);
    if (!row) return {};
    return this.decryptSafe(row.valuesEnc);
  }

  async set(agentId: string, userId: string, values: Record<string, string>): Promise<void> {
    const enc = this.secrets.encrypt(JSON.stringify(values));
    const now = new Date();
    await this.db
      .insert(agentVariables)
      .values({ agentId, userId, valuesEnc: enc, updatedAt: now })
      .onDuplicateKeyUpdate({ set: { valuesEnc: enc, updatedAt: now } });
  }

  async merge(
    agentId: string,
    userId: string,
    updates: Record<string, string | null>,
  ): Promise<Record<string, string>> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(agentVariables)
        .where(and(eq(agentVariables.agentId, agentId), eq(agentVariables.userId, userId)))
        .for("update");

      const existing = row ? this.decryptStrict(row.valuesEnc) : {};
      const merged = { ...existing };

      for (const [key, val] of Object.entries(updates)) {
        if (val === null) {
          delete merged[key];
        } else {
          merged[key] = val;
        }
      }

      const json = JSON.stringify(merged);
      if (json.length > MAX_TOTAL_SIZE) throw new VariableSizeExceeded();

      const enc = this.secrets.encrypt(json);
      const now = new Date();
      if (row) {
        await tx
          .update(agentVariables)
          .set({ valuesEnc: enc, updatedAt: now })
          .where(and(eq(agentVariables.agentId, agentId), eq(agentVariables.userId, userId)));
      } else {
        await tx.insert(agentVariables).values({ agentId, userId, valuesEnc: enc, updatedAt: now });
      }

      return merged;
    });
  }

  async delete(agentId: string, userId: string): Promise<void> {
    await this.db
      .delete(agentVariables)
      .where(and(eq(agentVariables.agentId, agentId), eq(agentVariables.userId, userId)));
  }
}
