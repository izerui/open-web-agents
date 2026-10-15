import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Capability } from "../src/lib/modules/capabilities/domain/catalog";
import { Client, newUser, serverUp } from "./client";

const databaseUrl = process.env.OWA_E2E_DATABASE_URL;
if (databaseUrl && new URL(databaseUrl).pathname !== "/owa_test")
  throw new Error("Capability E2E requires owa_test");

describe.skipIf(!databaseUrl)("platform capability pricing", () => {
  let admin: Client;
  let user: Client;
  let promotedId: string | undefined;
  const id = `e2e-model-${Date.now()}`;
  const definition = {
    id,
    name: "测试文本模型",
    kind: "llm",
    modelId: "private-routing-model",
    enabled: true,
    acceptsImages: true,
    rates: [{ meter: "input_token", units: "1000000", microCredits: "12000000" }],
  };
  async function database() {
    const { createConnection } = await import("mysql2/promise");
    if (!databaseUrl) throw new Error("missing test database");
    return createConnection(databaseUrl);
  }
  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("server unavailable");
    admin = await newUser("capability-admin");
    user = await newUser("capability-user");
    const me = await admin.get<{ user: { id: string; role: string } }>("/api/auth");
    if (me.body.user.role !== "admin") {
      promotedId = me.body.user.id;
      const db = await database();
      try {
        await db.execute("UPDATE users SET role = 'admin' WHERE id = ?", [promotedId]);
      } finally {
        await db.end();
      }
    }
  });
  afterAll(async () => {
    const db = await database();
    try {
      await db.execute("DELETE FROM capability_versions WHERE capability_id = ?", [id]);
      await db.execute("DELETE FROM capability_catalog WHERE id = ?", [id]);
      if (promotedId) await db.execute("UPDATE users SET role = 'user' WHERE id = ?", [promotedId]);
    } finally {
      await db.end();
    }
  });
  it("ordinary users and API keys cannot update prices", async () => {
    expect(
      (await user.post("/api/capabilities", { definition, expectedVersion: null })).status,
    ).toBe(403);
    const issued = await admin.post<{ plaintext: string }>("/api/keys", {
      name: "capability-test",
    });
    expect(
      (
        await new Client("api").post(
          "/api/capabilities",
          { definition, expectedVersion: null },
          {
            "X-Api-Key": issued.body.plaintext,
          },
        )
      ).status,
    ).toBe(403);
  });
  it("publishes versioned prices, preserves older versions and hides routing metadata", async () => {
    const first = await admin.post<{ capability: Capability }>("/api/capabilities", {
      definition,
      expectedVersion: null,
    });
    expect(first.status).toBe(201);
    expect(first.body.capability.version).toBe(1);
    const shown = await user.get<{ capabilities: Capability[] }>("/api/capabilities");
    const item = shown.body.capabilities.find((model) => model.id === id);
    expect(item?.rates).toEqual(definition.rates);
    expect(item).not.toHaveProperty("modelId");
    expect((await user.get("/api/capabilities?manage=1")).status).toBe(403);
    const second = await admin.post<{ capability: Capability }>("/api/capabilities", {
      expectedVersion: 1,
      definition: {
        ...definition,
        rates: [{ meter: "input_token", units: "1000000", microCredits: "24000000" }],
      },
    });
    expect(second.status).toBe(201);
    expect(second.body.capability.version).toBe(2);
    expect((await admin.post("/api/capabilities", { definition, expectedVersion: 1 })).status).toBe(
      409,
    );
    const db = await database();
    try {
      const [rows] = await db.execute(
        "SELECT definition FROM capability_versions WHERE capability_id = ? AND version = 1",
        [id],
      );
      const snapshot = (rows as { definition: { rates: unknown } }[])[0]?.definition;
      expect(snapshot?.rates).toEqual(definition.rates);
    } finally {
      await db.end();
    }
  });
  it("disabled models leave the public catalog without erasing their price history", async () => {
    expect(
      (
        await admin.post("/api/capabilities", {
          definition: { ...definition, enabled: false },
          expectedVersion: 2,
        })
      ).status,
    ).toBe(201);
    const result = await user.get<{ capabilities: Capability[] }>("/api/capabilities");
    expect(result.body.capabilities.some((item) => item.id === id)).toBe(false);
    const managed = await admin.get<{ capabilities: Capability[] }>("/api/capabilities?manage=1");
    expect(managed.body.capabilities.find((item) => item.id === id)?.version).toBe(3);
  });
});
