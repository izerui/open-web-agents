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
