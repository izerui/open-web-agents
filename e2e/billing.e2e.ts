import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, newUser, serverUp } from "./client";

const databaseUrl = process.env.OWA_E2E_DATABASE_URL;
if (databaseUrl && new URL(databaseUrl).pathname !== "/owa_test")
  throw new Error("Billing E2E requires owa_test");

describe.skipIf(!databaseUrl)("account credit ledger", () => {
  let admin: Client;
  let customer: Client;
  let other: Client;
  let accountId: string;
  let promotedId: string | undefined;
  const key = `manual-${Date.now()}`;
  async function db() {
    const mysql = await import("mysql2/promise");
    if (!databaseUrl) throw new Error("missing test database");
    return mysql.createConnection(databaseUrl);
  }
  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("server unavailable");
    admin = await newUser("billing-admin");
    customer = await newUser("billing-customer");
    other = await newUser("billing-other");
    accountId = (await customer.get<{ user: { id: string } }>("/api/auth")).body.user.id;
    const current = (await admin.get<{ user: { id: string; role: string } }>("/api/auth")).body
      .user;
    if (current.role !== "admin") {
      promotedId = current.id;
      const connection = await db();
      try {
        await connection.execute("UPDATE users SET role = 'admin' WHERE id = ?", [promotedId]);
      } finally {
        await connection.end();
      }
    }
  });
  afterAll(async () => {
    const connection = await db();
    try {
      if (accountId) {
        await connection.execute("DELETE FROM billing_ledger WHERE account_id = ?", [accountId]);
        await connection.execute("DELETE FROM billing_wallets WHERE account_id = ?", [accountId]);
      }
      if (promotedId)
        await connection.execute("UPDATE users SET role = 'user' WHERE id = ?", [promotedId]);
    } finally {
      await connection.end();
    }
  });
  const payload = (credits = "25.125001") => ({ accountId, credits, reason: "E2E 人工发放" });
  it("requires an authenticated account and blocks cross-account reads and non-admin credits", async () => {
    expect((await new Client("anon").get("/api/billing")).status).toBe(401);
    expect((await other.get(`/api/billing?accountId=${accountId}`)).status).toBe(403);
    expect(
      (await customer.post("/api/billing/credits", payload(), { "Idempotency-Key": key })).status,
    ).toBe(403);
    const apiKey = (await admin.post<{ plaintext: string }>("/api/keys", { name: "no-billing" }))
      .body.plaintext;
    const api = new Client("billing-api");
    expect((await api.get("/api/billing", { "X-Api-Key": apiKey })).status).toBe(403);
    expect(
      (
        await api.post("/api/billing/credits", payload(), {
          "Idempotency-Key": key,
          "X-Api-Key": apiKey,
        })
      ).status,
    ).toBe(403);
  });
  it("manual credit is exact and duplicate requests never double the balance", async () => {
    const first = await admin.post<{
      replayed: boolean;
      balance: { availableMicroCredits: string };
    }>("/api/billing/credits", payload(), { "Idempotency-Key": key });
    expect(first.status).toBe(201);
    expect(first.body.balance.availableMicroCredits).toBe("25125001");
    const replay = await admin.post<{ replayed: boolean }>("/api/billing/credits", payload(), {
      "Idempotency-Key": key,
    });
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(
      (await admin.post("/api/billing/credits", payload("99"), { "Idempotency-Key": key })).status,
    ).toBe(409);
    const statement = await customer.get<{
      balance: { availableMicroCredits: string; reservedMicroCredits: string };
      items: { kind: string; amountMicroCredits: string }[];
      automaticCharging: boolean;
      paymentsConnected: boolean;
    }>("/api/billing");
    expect(statement.status).toBe(200);
    expect(statement.body.balance).toMatchObject({
      availableMicroCredits: "25125001",
      reservedMicroCredits: "0",
    });
    expect(statement.body.items).toHaveLength(1);
    expect(statement.body.items[0]).toMatchObject({
      kind: "credit",
      amountMicroCredits: "25125001",
    });
    expect(statement.body.automaticCharging).toBe(false);
    expect(statement.body.paymentsConnected).toBe(false);
  });
  it("ledger cursors are scoped to the account and pagination does not repeat entries", async () => {
    expect(
      (
        await admin.post("/api/billing/credits", payload("0.000001"), {
          "Idempotency-Key": `${key}-2`,
        })
      ).status,
    ).toBe(201);
    type Page = { items: { id: string }[]; nextCursor?: string };
    const first = (await customer.get<Page>("/api/billing?limit=1")).body;
    expect(first.nextCursor).toBeTruthy();
    const next = (
      await customer.get<Page>(
        `/api/billing?limit=1&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
      )
    ).body;
    expect(next.items).toHaveLength(1);
    expect(first.items[0]?.id).not.toBe(next.items[0]?.id);
    expect(
      (await other.get(`/api/billing?cursor=${encodeURIComponent(first.nextCursor ?? "")}`)).status,
    ).toBe(400);
  });
});

describe.skipIf(!databaseUrl)("按邮箱批量发放积分", () => {
  let admin: Client;
  let promotedId: string | undefined;
  const people: { client: Client; id: string; email: string }[] = [];
  async function db() {
    const mysql = await import("mysql2/promise");
    if (!databaseUrl) throw new Error("missing test database");
    return mysql.createConnection(databaseUrl);
  }
  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("server unavailable");
    admin = await newUser("batch-admin");
    const me = (await admin.get<{ user: { id: string; role: string } }>("/api/auth")).body.user;
    if (me.role !== "admin") {
      promotedId = me.id;
      const c = await db();
      try {
        await c.execute("UPDATE users SET role = 'admin' WHERE id = ?", [promotedId]);
      } finally {
        await c.end();
      }
    }
    for (const tag of ["batch-a", "batch-b", "batch-off"]) {
      const client = await newUser(tag);
      const u = (await client.get<{ user: { id: string; email: string } }>("/api/auth")).body.user;
      people.push({ client, id: u.id, email: u.email });
    }
    const c = await db();
    try {
      await c.execute("UPDATE users SET disabled = 1 WHERE id = ?", [people[2]?.id]);
    } finally {
      await c.end();
    }
  });
  afterAll(async () => {
    if (!promotedId) return;
    const c = await db();
    try {
      await c.execute("UPDATE users SET role = 'user' WHERE id = ?", [promotedId]);
    } finally {
      await c.end();
    }
  });

  type Line = { email: string; status: string };
  type Result = { lines: Line[]; credited: number; replayed: number; skipped: number };
  const batchKey = `batch-${Date.now()}`;
  const emails = () =>
    [
      people[0]?.email.toUpperCase(),
      people[1]?.email,
      people[2]?.email,
      `nobody-${Date.now()}@example.test`,
      people[0]?.email,
    ].join("\n");
  const balance = async (c: Client) =>
    (await c.get<{ balance: { availableMicroCredits: string } }>("/api/billing")).body.balance
      .availableMicroCredits;

  it("普通账号不能用", async () => {
    const r = await people[0]?.client.post("/api/billing/credits/batch", {
      emails: "a@example.test",
      preview: true,
    });
    expect(r?.status).toBe(403);
  });

  it("预览不入账;发放只给可发放的账号,每人一次;同批次重试不重复;当事人看得到审计", async () => {
    const preview = await admin.post<Result>("/api/billing/credits/batch", {
      emails: emails(),
      preview: true,
    });
    expect(preview.status).toBe(200);
    expect(preview.body.lines.map((l) => l.status)).toEqual([
      "ready",
      "ready",
      "disabled",
      "not_found",
      "duplicate",
    ]);
    expect(await balance(people[0]?.client as Client)).toBe("0");

    const body = { emails: emails(), credits: "12.5", reason: "E2E 批量发放" };
    const first = await admin.post<Result>("/api/billing/credits/batch", body, {
      "Idempotency-Key": batchKey,
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ credited: 2, replayed: 0, skipped: 3 });
    expect(await balance(people[0]?.client as Client)).toBe("12500000");
    expect(await balance(people[1]?.client as Client)).toBe("12500000");

    const again = await admin.post<Result>("/api/billing/credits/batch", body, {
      "Idempotency-Key": batchKey,
    });
    expect(again.body).toMatchObject({ credited: 0, replayed: 2 });
    expect(await balance(people[0]?.client as Client)).toBe("12500000");

    // 停用账号没有入账
    const c = await db();
    try {
      const [rows] = await c.execute(
        "SELECT COUNT(*) AS n FROM billing_ledger WHERE account_id = ?",
        [people[2]?.id],
      );
      expect(Number((rows as { n: number }[])[0]?.n)).toBe(0);
    } finally {
      await c.end();
    }

    type Audit = { items: { action: string; details?: { via?: string } }[] };
    const audit = (await people[1]?.client.get<Audit>("/api/audit?limit=50"))?.body;
    const credits = audit?.items.filter((i) => i.action === "billing.credit") ?? [];
    expect(credits).toHaveLength(1);
    expect(credits[0]?.details?.via).toBe("batch");
  });

  it("到账后审计缺失、账号被停用:原批次重试补齐审计,余额不变", async () => {
    const target = await newUser("batch-late");
    const u = (await target.get<{ user: { id: string; email: string } }>("/api/auth")).body.user;
    const key = `batch-late-${Date.now()}`;
    const body = { emails: u.email, credits: "3", reason: "E2E 补审计" };
    const first = await admin.post<Result>("/api/billing/credits/batch", body, {
      "Idempotency-Key": key,
    });
    expect(first.body).toMatchObject({ credited: 1 });
    const c = await db();
    try {
      // 模拟上次审计没写成;随后管理员停用了这个账号
      await c.execute("DELETE FROM audit_logs WHERE owner_id = ? AND action = 'billing.credit'", [
        u.id,
      ]);
      await c.execute("UPDATE users SET disabled = 1 WHERE id = ?", [u.id]);
    } finally {
      await c.end();
    }
    const again = await admin.post<Result>("/api/billing/credits/batch", body, {
      "Idempotency-Key": key,
    });
    expect(again.body.lines.map((l) => l.status)).toEqual(["replayed"]);
    // 停用账号用新批次仍拿不到
    const fresh = await admin.post<Result>("/api/billing/credits/batch", body, {
      "Idempotency-Key": `${key}-new`,
    });
    expect(fresh.body.lines.map((l) => l.status)).toEqual(["disabled"]);

    const c2 = await db();
    try {
      const [w] = await c2.execute(
        "SELECT available_micro_credits AS v FROM billing_wallets WHERE account_id = ?",
        [u.id],
      );
      expect(String((w as { v: string }[])[0]?.v)).toBe("3000000");
      const [a] = await c2.execute(
        "SELECT COUNT(*) AS n FROM audit_logs WHERE owner_id = ? AND action = 'billing.credit'",
        [u.id],
      );
      expect(Number((a as { n: number }[])[0]?.n)).toBe(1);
    } finally {
      await c2.end();
    }
  });
});
