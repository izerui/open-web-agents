import type { Db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import type { NewUser, User, UserRepo } from "@/lib/modules/identity/user-ports";
import { eq, sql } from "drizzle-orm";

interface Row {
  id: string;
  email: string;
  role: string;
  defaultBaseUrl: string | null;
  anthropicKeyEnc: string | null;
  createdAt: Date;
}

const COLUMNS = {
  id: users.id,
  email: users.email,
  role: users.role,
  defaultBaseUrl: users.defaultBaseUrl,
  anthropicKeyEnc: users.anthropicKeyEnc,
  createdAt: users.createdAt,
};

function toUser(r: Row): User {
  return {
    id: r.id,
    email: r.email,
    role: r.role === "admin" ? "admin" : "user",
    defaultBaseUrl: r.defaultBaseUrl ?? undefined,
    anthropicKeyEnc: r.anthropicKeyEnc ?? undefined,
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

  async setCredentials(
    id: string,
    v: { defaultBaseUrl?: string | null; anthropicKeyEnc?: string | null },
  ): Promise<void> {
    const patch: Record<string, string | null> = {};
    if (v.defaultBaseUrl !== undefined) patch.defaultBaseUrl = v.defaultBaseUrl;
    if (v.anthropicKeyEnc !== undefined) patch.anthropicKeyEnc = v.anthropicKeyEnc;
    if (Object.keys(patch).length === 0) return;
    await this.db.update(users).set(patch).where(eq(users.id, id));
  }
}
