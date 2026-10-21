import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, newUser, passDraftEval, serverUp } from "./client";

const databaseUrl = process.env.OWA_E2E_DATABASE_URL;
if (databaseUrl && new URL(databaseUrl).pathname !== "/owa_test") {
  throw new Error("Market E2E account setup requires the dedicated owa_test database");
}
if (!databaseUrl)
  console.warn("[skip] Market E2E requires OWA_E2E_DATABASE_URL pointing to owa_test");

describe.skipIf(!databaseUrl)("market end-to-end", () => {
  let admin: Client;
  let owner: Client;
  let customer: Client;
  let promotedId: string | undefined;
  const secret = "market-private-definition-83f2";
  const context = (id: string) => `/api/market/${id}`;
  const listing = { listed: true, category: "research" };

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("Market E2E requires a running test server");
    admin = await newUser("market-admin");
    owner = await newUser("market-owner");
    customer = await newUser("market-customer");
    const me = await admin.get<{ user: { id: string; role: string } }>("/api/auth");
    expect(me.status).toBe(200);
    if (me.body.user.role !== "admin") {
      if (!databaseUrl) throw new Error("missing test database");
      const mysql = await import("mysql2/promise");
      const db = await mysql.createConnection(databaseUrl);
      try {
        const [result] = await db.execute("UPDATE users SET role = 'admin' WHERE id = ?", [
          me.body.user.id,
        ]);
        promotedId = me.body.user.id;
        expect((result as { affectedRows: number }).affectedRows).toBe(1);
      } finally {
        await db.end();
      }
    }
    expect((await admin.get<{ user: { role: string } }>("/api/auth")).body.user.role).toBe("admin");
  });

  afterAll(async () => {
    if (!promotedId || !databaseUrl) return;
    const mysql = await import("mysql2/promise");
    const db = await mysql.createConnection(databaseUrl);
    try {
      await db.execute("UPDATE users SET role = 'user' WHERE id = ?", [promotedId]);
    } finally {
      await db.end();
    }
  });

  async function create(publish = true) {
    const response = await owner.post<{ agent: { id: string } }>("/api/agents", {
      name: "Published market research",
      description: "Research public information",
      config: {
        systemPrompt: secret,
        model: "sonnet",
        starters: ["Research a topic"],
        skillPackages: [
          {
            name: "report",
            description: "Report",
            files: { "SKILL.md": `# ${secret}`, "scripts/run.sh": secret },
          },
        ],
        mcpServers: [
          { name: "internal", type: "http", url: `https://mcp.example.com?key=${secret}` },
        ],
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
        outputSchema: { type: "object", properties: { answer: { type: "string" } } },
      },
    });
    expect(response.status).toBe(201);
    const id = response.body.agent.id;
    if (publish) {
      await passDraftEval(owner, id, { query: "发布门槛" });
      expect((await owner.post(`/api/agents/${id}/versions`, {})).status).toBe(201);
    }
    return id;
  }

  async function listed() {
    const id = await create();
    expect((await admin.patch(context(id), listing)).status).toBe(200);
    return id;
  }

  it("only admins list published agents; executor and unpublished agents are refused", async () => {
    const id = await create();
    expect((await owner.patch(context(id), listing)).status).toBe(403);
    expect((await customer.get("/api/market?manage=true")).status).toBe(403);
    expect((await admin.patch(context(await create(false)), listing)).status).toBe(409);
    expect((await admin.patch(context("agent-architect"), listing)).status).toBe(404);
    expect((await admin.patch(context(id), listing)).status).toBe(200);
    const result = await customer.get<{ items: { id: string }[] }>(
      "/api/market?q=research&category=research",
    );
    expect(result.status).toBe(200);
    expect(result.body.items.some((item) => item.id === id)).toBe(true);
    expect(result.body.items.some((item) => item.id === "agent-architect")).toBe(false);
  });

  it("use-only responses contain public contracts but no definitions; config/version reads are denied", async () => {
    const id = await listed();
    const detail = await customer.get<{ agent: { config: Record<string, unknown> } }>(context(id));
    expect(detail.status).toBe(200);
    expect(detail.body.agent.config).toHaveProperty("inputSchema");
    expect(detail.body.agent.config).toHaveProperty("outputSchema");
    expect(detail.body.agent.config).not.toHaveProperty("systemPrompt");
    const agents = await customer.get<{
      agents: { id: string; config: Record<string, unknown> }[];
    }>("/api/agents");
    const item = agents.body.agents.find((entry) => entry.id === id);
    expect(item).toBeDefined();
    expect(JSON.stringify([detail.body, item])).not.toContain(secret);
    for (const field of ["systemPrompt", "skillPackages", "mcpServers", "escapeHatch"]) {
      expect(item?.config).not.toHaveProperty(field);
    }
    expect((await customer.get(`/api/agents/${id}/versions`)).status).toBe(404);
    expect((await customer.get(`/api/agents/${id}/versions/1`)).status).toBe(404);
    expect((await customer.get(`/api/agents/${id}/knowledge`)).status).toBe(404);
    expect(
      (
        await customer.post("/api/agents", {
          id,
          name: "Tampered",
          config: { systemPrompt: "tampered", model: "sonnet" },
        })
      ).status,
    ).toBe(404);
    expect((await customer.get(`/api/agents/${id}/openapi.json`)).status).toBe(200);
  });

  it("author market use pins published; author trial stays draft; customers and API keys cannot request drafts", async () => {
    const id = await listed();
    expect(
      (
        await owner.post("/api/agents", {
          id,
          name: "Unpublished draft",
          config: { systemPrompt: "New unpublished prompt", model: "sonnet" },
        })
      ).status,
    ).toBe(201);
    const market = await owner.post<{ session: { agentVersion?: number } }>("/api/sessions", {
      agentId: id,
      versionMode: "published",
    });
    expect(market.status).toBe(201);
    expect(market.body.session.agentVersion).toBe(1);
    for (const versionMode of [undefined, "draft"]) {
      const trial = await owner.post<{ session: { agentVersion?: number } }>("/api/sessions", {
        agentId: id,
        versionMode,
      });
      expect(trial.status).toBe(201);
      expect(trial.body.session.agentVersion).toBeUndefined();
    }
    const ordinary = await customer.post<{ session: { agentVersion?: number } }>("/api/sessions", {
      agentId: id,
    });
    expect(ordinary.status).toBe(201);
    expect(ordinary.body.session.agentVersion).toBe(1);
    expect(
      (await customer.post("/api/sessions", { agentId: id, versionMode: "draft" })).status,
    ).toBe(403);
    const key = await owner.post<{ plaintext: string }>("/api/keys", {
      agentId: id,
      name: "market-trial",
    });
    expect(key.status).toBe(201);
    expect(
      (
        await new Client("market-key").post(
          "/api/sessions",
          {
            agentId: id,
            versionMode: "draft",
          },
          { "X-Api-Key": key.body.plaintext },
        )
      ).status,
    ).toBe(403);
  });

  it("unlisting stops new use while retaining history and independent read shares", async () => {
    const id = await listed();
    const session = await customer.post<{ session: { id: string } }>("/api/sessions", {
      agentId: id,
    });
    expect(session.status).toBe(201);
    expect((await admin.patch(context(id), { ...listing, listed: false })).status).toBe(200);
    expect((await customer.get(context(id))).status).toBe(404);
    expect((await customer.post("/api/sessions", { agentId: id })).status).toBe(403);
    const history = await customer.get<{ sessions: { id: string }[] }>("/api/sessions");
    expect(history.body.sessions.some((item) => item.id === session.body.session.id)).toBe(true);
    const share = await owner.post<{ grant: { id: string } }>(`/api/agents/${id}/share`, {
      target: "public",
      permission: "read",
    });
    expect(share.status).toBe(201);
    expect((await admin.patch(context(id), listing)).status).toBe(200);
    expect((await admin.patch(context(id), { ...listing, listed: false })).status).toBe(200);
    const grants = await owner.get<{ grants: { id: string; permission: string }[] }>(
      `/api/agents/${id}/share`,
    );
    expect(grants.body.grants).toContainEqual(
      expect.objectContaining({
        id: share.body.grant.id,
        permission: "read",
      }),
    );
    expect((await customer.post("/api/sessions", { agentId: id })).status).toBe(201);
    expect((await customer.get(`/api/agents/${id}/versions/1`)).status).toBe(200);
    expect(
      (await customer.post("/api/sessions", { agentId: id, versionMode: "draft" })).status,
    ).toBe(403);
  });
});
