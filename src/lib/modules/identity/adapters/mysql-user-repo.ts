import type { Db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import type { NewUser, User, UserRepo } from "@/lib/modules/identity/user-ports";
import { desc, eq, sql } from "drizzle-orm";

interface Row {
  id: string;
  email: string;
  role: string;
  defaultBaseUrl: string | null;
  anthropicKeyEnc: string | null;
  webhookSecretEnc: string | null;
  disabled: number;
  monthlyQuotaMicroUsd: number | null;
  createdAt: Date;
}

const COLUMNS = {
  id: users.id,
  email: users.email,
  role: users.role,
  defaultBaseUrl: users.defaultBaseUrl,
  anthropicKeyEnc: users.anthropicKeyEnc,
  webhookSecretEnc: users.webhookSecretEnc,
  disabled: users.disabled,
  monthlyQuotaMicroUsd: users.monthlyQuotaMicroUsd,
  createdAt: users.createdAt,
};

function toUser(r: Row): User {
  return {
    id: r.id,
    email: r.email,
    role: r.role === "admin" ? "admin" : "user",
    defaultBaseUrl: r.defaultBaseUrl ?? undefined,
    anthropicKeyEnc: r.anthropicKeyEnc ?? undefined,
    webhookSecretEnc: r.webhookSecretEnc ?? undefined,
    // 存量行是 NULL(加列前就有的数据),按"未禁用"处理
    disabled: Number(r.disabled ?? 0) !== 0,
    monthlyQuotaMicroUsd: r.monthlyQuotaMicroUsd ?? undefined,
    createdAt: r.createdAt.getTime(),
  };
}

/** 邮箱统一小写存取,避免 Foo@x 与 foo@x 被当成两个账号。 */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class MysqlUserRepo implements UserRepo {
  constructor(private readonly db: Db) {}

  async create(u: NewUser): Promise<User> {
    await this.db.insert(users).values({
      id: u.id,
      email: normalizeEmail(u.email),
      passwordHash: u.passwordHash,
      role: u.role ?? "user",
    });
    const created = await this.get(u.id);
    if (!created) throw new Error(`user insert failed: ${u.id}`);
    return created;
  }

  async registerSelf(
    u: Omit<NewUser, "role">,
    opts: { allowOthers: boolean },
  ): Promise<User | null> {
    const created = await this.db.transaction(async (tx) => {
      // 主键唯一:并发的注册里只有一个事务插得进,其余等它提交后得到"已存在"
      const res = await tx.execute(
        sql`INSERT IGNORE INTO platform_state (k, v) VALUES ('first_admin', ${u.id})`,
      );
      const first = affectedRows(res) === 1;
      if (!first && !opts.allowOthers) return false;
      await tx.insert(users).values({
        id: u.id,
        email: normalizeEmail(u.email),
        passwordHash: u.passwordHash,
        role: first ? "admin" : "user",
      });
      return true;
    });
    return created ? this.get(u.id) : null;
  }

  async findByEmail(email: string): Promise<(User & { passwordHash: string }) | null> {
    const rows = await this.db
      .select({ ...COLUMNS, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.email, normalizeEmail(email)))
      .limit(1);
    const row = rows[0];
    return row ? { ...toUser(row), passwordHash: row.passwordHash } : null;
  }

  async get(id: string): Promise<User | null> {
    const rows = await this.db.select(COLUMNS).from(users).where(eq(users.id, id)).limit(1);
    const row = rows[0];
    return row ? toUser(row) : null;
  }

  async count(): Promise<number> {
    const rows = await this.db.select({ n: sql<number>`COUNT(*)` }).from(users);
    return Number(rows[0]?.n ?? 0);
  }

  async listAll(limit = 500): Promise<User[]> {
    const rows = await this.db
      .select(COLUMNS)
      .from(users)
      .orderBy(desc(users.createdAt))
      .limit(limit);
    return rows.map(toUser);
  }

  async adminUpdate(
    id: string,
    v: { role?: "admin" | "user"; disabled?: boolean; monthlyQuotaMicroUsd?: number | null },
  ): Promise<void> {
    const patch: Record<string, string | number | null> = {};
    if (v.role !== undefined) patch.role = v.role;
    if (v.disabled !== undefined) patch.disabled = v.disabled ? 1 : 0;
    if (v.monthlyQuotaMicroUsd !== undefined) patch.monthlyQuotaMicroUsd = v.monthlyQuotaMicroUsd;
    // 【为什么空补丁要早退】drizzle 的 update().set({}) 会生成非法 SQL 直接抛错
    if (Object.keys(patch).length === 0) return;
    await this.db.update(users).set(patch).where(eq(users.id, id));
  }

  async countAdmins(): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`COUNT(*)` })
      .from(users)
      .where(eq(users.role, "admin"));
    return Number(rows[0]?.n ?? 0);
  }

  async setPasswordHash(id: string, passwordHash: string): Promise<void> {
    await this.db.update(users).set({ passwordHash }).where(eq(users.id, id));
  }

  async getWithPassword(id: string): Promise<(User & { passwordHash: string }) | null> {
    const rows = await this.db
      .select({ ...COLUMNS, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    const row = rows[0];
    return row ? { ...toUser(row), passwordHash: row.passwordHash } : null;
  }

  async setCredentials(
    id: string,
    v: {
      defaultBaseUrl?: string | null;
      anthropicKeyEnc?: string | null;
      webhookSecretEnc?: string | null;
    },
  ): Promise<void> {
    const patch: Record<string, string | null> = {};
    if (v.defaultBaseUrl !== undefined) patch.defaultBaseUrl = v.defaultBaseUrl;
    if (v.anthropicKeyEnc !== undefined) patch.anthropicKeyEnc = v.anthropicKeyEnc;
    if (v.webhookSecretEnc !== undefined) patch.webhookSecretEnc = v.webhookSecretEnc;
    if (Object.keys(patch).length === 0) return;
    await this.db.update(users).set(patch).where(eq(users.id, id));
  }
}

/** drizzle 的 mysql2 driver 返回 `[ResultSetHeader, FieldPacket[]]`,affectedRows 在 res[0] 上 */
function affectedRows(res: unknown): number {
  if (Array.isArray(res)) {
    return (res[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
  }
  return (res as { affectedRows?: number } | null)?.affectedRows ?? 0;
}
