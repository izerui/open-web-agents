// 模型与价目:只有管理员能维护;价格按版本保存;用户视图不含提供者、上游模型标识与凭证。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Capability } from "../src/lib/modules/capabilities/domain/catalog";
import { Client, newUser, serverUp } from "./client";

const databaseUrl = process.env.OWA_E2E_DATABASE_URL;
if (databaseUrl && !/test/i.test(new URL(databaseUrl).pathname)) {
  throw new Error("Model admin E2E requires a dedicated test database");
}

describe.skipIf(!databaseUrl)("模型提供者与价目", () => {
  let admin: Client;
  let user: Client;
  let promotedId: string | undefined;
  let providerId = "";
  const tag = Date.now();
  const definition = (over: Record<string, unknown> = {}) => ({
    name: `测试文本模型-${tag}`,
    kind: "llm",
    modelId: `private-routing-model-${tag}`,
    enabled: true,
    acceptsImages: true,
    providerId,
    markupBp: 1000,
    costRates: [
      { meter: "input_token", units: "1000000", microCredits: "1200000000" },
      { meter: "output_token", units: "1000000", microCredits: "6000000000" },
      { meter: "cache_read_token", units: "1000000", microCredits: "0" },
      { meter: "cache_write_token", units: "1000000", microCredits: "0" },
    ],
    rates: [],
    ...over,
  });
  async function database() {
    const { createConnection } = await import("mysql2/promise");
    if (!databaseUrl) throw new Error("missing test database");
    return createConnection(databaseUrl);
  }
  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("server unavailable");
    admin = await newUser("model-admin");
    user = await newUser("model-user");
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
    const p = await admin.post<{ provider: { id: string } }>("/api/admin/providers", {
      definition: { name: `价目测试-${tag}`, enabled: true, endpoints: {} },
      apiKey: `sk-private-${tag}`,
    });
    providerId = p.body.provider.id;
  });
  afterAll(async () => {
    if (!promotedId) return;
    const db = await database();
    try {
      await db.execute("UPDATE users SET role = 'user' WHERE id = ?", [promotedId]);
    } finally {
      await db.end();
    }
  });

  it("普通用户与 API Key 不能维护提供者和模型", async () => {
    expect((await user.post("/api/admin/models", { definition: definition() })).status).toBe(403);
    expect((await user.get("/api/admin/providers")).status).toBe(403);
    const issued = await admin.post<{ plaintext: string }>("/api/keys", { name: "model-test" });
    const api = new Client("api");
    const headers = { "X-Api-Key": issued.body.plaintext };
    expect(
      (await api.post("/api/admin/models", { definition: definition() }, headers)).status,
    ).toBe(403);
    expect((await api.get("/api/admin/providers", headers)).status).toBe(403);
  });

  it("售价由成本与加价派生、按版本保存;用户视图不含路由信息与凭证", async () => {
    const first = await admin.post<{ model: Capability }>("/api/admin/models", {
      definition: definition(),
      expectedVersion: null,
    });
    expect(first.status).toBe(201);
    const id = first.body.model.id;
    expect(first.body.model.rates[0]?.microCredits).toBe("1320000000");

    const shown = await user.get<{ capabilities: Record<string, unknown>[] }>("/api/capabilities");
    const text = JSON.stringify(shown.body);
    const item = shown.body.capabilities.find((m) => m.id === id);
    expect(item?.rates).toEqual(first.body.model.rates);
    for (const hidden of [
      `private-routing-model-${tag}`,
      providerId,
      `价目测试-${tag}`,
      "sk-private",
      "costRates",
    ]) {
      expect(text).not.toContain(hidden);
    }

    const second = await admin.post<{ model: Capability }>("/api/admin/models", {
      expectedVersion: 1,
      definition: { ...definition(), id, markupBp: 2000 },
    });
    expect(second.body.model.version).toBe(2);
    expect(
      (
        await admin.post("/api/admin/models", {
          definition: { ...definition(), id },
          expectedVersion: 1,
        })
      ).status,
    ).toBe(409);
    const db = await database();
    try {
      const [rows] = await db.execute(
        "SELECT definition FROM capability_versions WHERE capability_id = ? AND version = 1",
        [id],
      );
      const snapshot = (
        rows as { definition: { rates: { microCredits: string }[]; markupBp: number } }[]
      )[0]?.definition;
      expect(snapshot?.markupBp).toBe(1000);
      expect(snapshot?.rates[0]?.microCredits).toBe("1320000000");
    } finally {
      await db.end();
    }

    // 停用后离开用户目录,历史版本仍在
    expect(
      (
        await admin.post("/api/admin/models", {
          definition: { ...definition(), id, enabled: false },
          expectedVersion: 2,
        })
      ).status,
    ).toBe(200);
    const after = await user.get<{ capabilities: { id: string }[] }>("/api/capabilities");
    expect(after.body.capabilities.some((m) => m.id === id)).toBe(false);
    const managed = await admin.get<{ models: Capability[] }>("/api/admin/models");
    expect(managed.body.models.find((m) => m.id === id)?.version).toBe(3);
  });

  it("匿名请求 /api/health 不含模型映射与任何上游模型标识", async () => {
    const all = await admin.get<{ models: Capability[] }>("/api/admin/models");
    const upstream = all.body.models.map((m) => m.modelId);
    expect(upstream.length).toBeGreaterThan(0);
    const res = await new Client("anon-health").get<{ config?: Record<string, unknown> }>(
      "/api/health",
    );
    expect(res.status).toBe(200);
    expect(res.body.config).toBeTruthy();
    expect(res.body.config).not.toHaveProperty("models");
    const text = JSON.stringify(res.body);
    for (const id of upstream) expect(text, id).not.toContain(`"${id}"`);
  });
});
