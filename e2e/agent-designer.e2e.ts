// HTTP contract only: no model calls or writes of generated skill packages.
import { beforeAll, describe, expect, it } from "vitest";
import { Client, newUser, serverUp } from "./client";

type Draft = {
  name: string;
  description: string;
  systemPrompt: string;
  parameters: Record<string, unknown>;
  skillRefs: string[];
  mcpRefs: string[];
};
type View = {
  sessionId: string;
  legacy: boolean;
  draft: Draft;
  revision: string;
  previewToken: string;
  conflict: boolean;
  issues: { field: string; message: string }[];
  resources: { ref: string; kind: "skill" | "mcp"; name: string }[];
  changes: unknown[];
};
type Apply = { agent: { id: string; name: string }; created: boolean; code?: string };
type SavedAgent = {
  id: string;
  name: string;
  webhookUrl?: string;
  publishedVersion?: number;
  config: {
    systemPrompt: string;
    skillPackages?: { name: string; files: Record<string, string> }[];
    mcpServers?: { name: string; url?: string }[];
  };
};
const EXECUTOR = "agent-architect";
const draft = (): Draft => ({
  name: "Draft agent",
  description: "Existing capabilities only",
  systemPrompt: "Answer carefully",
  parameters: { model: "sonnet", maxTurns: 20 },
  skillRefs: [],
  mcpRefs: [],
});

describe("platform AI editor", () => {
  let user: Client;
  let other: Client;
  let key: string;
  const api = new Client("designer-api");
  const path = (id: string) => `/api/agents/design/${id}`;
  const inspect = async (id: string) => {
    const response = await user.get<View>(path(id));
    expect(response.status).toBe(200);
    expect(response.body.legacy).toBe(false);
    expect(response.body.previewToken).toBeTruthy();
    expect(response.body.revision).toBeTruthy();
    return response.body;
  };
  const start = async (agentId?: string) => {
    const response = await user.post<{ sessionId: string }>("/api/agents/design", { agentId });
    expect(response.status).toBe(201);
    expect(response.body.sessionId).toBeTruthy();
    return response.body.sessionId;
  };
  const edit = async (id: string, next: Draft, resourceAgentIds?: string[]) => {
    const before = await inspect(id);
    const response = await user.patch<View>(path(id), {
      revision: before.revision,
      draft: next,
      resourceAgentIds,
    });
    expect(response.status).toBe(200);
    return inspect(id);
  };
  const apply = (id: string, previewToken?: string) =>
    user.post<Apply>("/api/agents/design/apply", { sessionId: id, previewToken });
  const createAgent = async (c: Client = user, extra: Record<string, unknown> = {}) => {
    const response = await c.post<{ agent: { id: string } }>("/api/agents", {
      name: "Existing agent",
      config: { systemPrompt: "Original", model: "sonnet" },
      ...extra,
    });
    expect(response.status).toBe(201);
    return response.body.agent.id;
  };
  const agent = async (id: string) => {
    const response = await user.get<{ agents: SavedAgent[] }>("/api/agents");
    expect(response.status).toBe(200);
    const found = response.body.agents.find((a) => a.id === id);
    expect(found).toBeDefined();
    if (!found) throw new Error(`agent not found: ${id}`);
    return found;
  };

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e requires a running test server");
    user = await newUser("designer");
    other = await newUser("designer-other");
    const issued = await user.post<{ plaintext: string }>("/api/keys", { name: "designer-test" });
    expect(issued.status).toBe(201);
    key = issued.body.plaintext;
    expect(key).toBeTruthy();
  });

  it("hides the executor and denies all ordinary entry points", async () => {
    for (const client of [user, other]) {
      const list = await client.get<{ agents: { id: string }[] }>("/api/agents");
      expect(list.status).toBe(200);
      expect(list.body.agents.some((a) => a.id === EXECUTOR)).toBe(false);
      const requests: [string, string, unknown?][] = [
        ["POST", "/api/sessions", { agentId: EXECUTOR }],
        ["POST", `/api/agents/${EXECUTOR}/share`, { target: "public", permission: "write" }],
        ["GET", `/api/agents/${EXECUTOR}/share`],
        ["POST", `/api/agents/${EXECUTOR}/versions`, { note: "must fail" }],
        [
          "POST",
          "/api/agents",
          {
            id: EXECUTOR,
            name: "Override",
            config: { systemPrompt: "Override", model: "sonnet" },
          },
        ],
        ["POST", "/api/keys", { name: "Forbidden binding", agentId: EXECUTOR }],
        ["POST", "/api/agents/design", { agentId: EXECUTOR }],
      ];
      for (const [method, endpoint, body] of requests) {
        const response = await client.req(method, endpoint, { body });
        expect([403, 404], `${method} ${endpoint}`).toContain(response.status);
      }
    }
    const invoked = await api.post(
      `/api/agents/${EXECUTOR}/invoke`,
      { input: "must fail" },
      { "X-Api-Key": key },
    );
    expect([403, 404]).toContain(invoked.status);
  });

  it("creates and then edits one agent through revision + previewToken", async () => {
    const id = await start();
    const empty = await inspect(id);
    expect(empty.issues.length).toBeGreaterThan(0);
    expect((await apply(id, empty.previewToken)).status).toBe(400);
    expect((await apply(id)).body.code).toBe("preview_changed");
    const ready = await edit(id, draft());
    expect(ready.issues).toEqual([]);
    expect(ready.changes.length).toBeGreaterThan(0);
    const created = await apply(id, ready.previewToken);
    expect(created.status).toBe(200);
    expect(created.body.created).toBe(true);
    expect((await agent(created.body.agent.id)).config.skillPackages ?? []).toEqual([]);
    const next = await edit(id, { ...ready.draft, systemPrompt: "More precise" });
    const saved = await apply(id, next.previewToken);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ created: false, agent: created.body.agent });
    expect((await agent(saved.body.agent.id)).config.systemPrompt).toBe("More precise");
    expect((await inspect(id)).conflict).toBe(false);
  });

  it("lists design history separately and only for its owner", async () => {
    const id = await start();
    const own = await user.get<{ sessions: { id: string }[] }>("/api/agents/design");
    const foreign = await other.get<{ sessions: { id: string }[] }>("/api/agents/design");
    const ordinary = await user.get<{ sessions: { id: string }[] }>("/api/sessions");
    expect(own.status).toBe(200);
    expect(foreign.status).toBe(200);
    expect(ordinary.status).toBe(200);
    expect(own.body.sessions.some((s) => s.id === id)).toBe(true);
    expect(foreign.body.sessions.some((s) => s.id === id)).toBe(false);
    expect(ordinary.body.sessions.some((s) => s.id === id)).toBe(false);
  });

  it("rejects foreign targets/sessions and ordinary sessions even when owned", async () => {
    const theirs = await createAgent(other);
    expect((await user.post("/api/agents/design", { agentId: theirs })).status).toBe(403);
    const id = await start();
    const view = await inspect(id);
    expect((await other.get(path(id))).status).toBe(404);
    expect((await other.patch(path(id), { revision: view.revision, reset: true })).status).toBe(
      404,
    );
    expect(
      (
        await other.post("/api/agents/design/apply", {
          sessionId: id,
          previewToken: view.previewToken,
        })
      ).status,
    ).toBe(404);
    const ownAgent = await createAgent();
    const ordinary = await user.post<{ session: { id: string } }>("/api/sessions", {
      agentId: ownAgent,
    });
    expect(ordinary.status).toBe(201);
    expect((await user.get(path(ordinary.body.session.id))).status).toBe(404);
    expect((await apply(ordinary.body.session.id, view.previewToken)).status).toBe(404);
  });

  it("rejects API keys on every dedicated design endpoint", async () => {
    const id = await start();
    const view = await inspect(id);
    const requests: [string, string, unknown?][] = [
      ["GET", "/api/agents/design"],
      ["POST", "/api/agents/design", {}],
      ["GET", path(id)],
      ["PATCH", path(id), { revision: view.revision, reset: true }],
      ["POST", "/api/agents/design/apply", { sessionId: id, previewToken: view.previewToken }],
      ["POST", `${path(id)}/run`, { prompt: "must fail", revision: view.revision }],
    ];
    for (const [method, endpoint, body] of requests) {
      const response = await api.req(method, endpoint, { body, headers: { "X-Api-Key": key } });
      expect([401, 403], `${method} ${endpoint}`).toContain(response.status);
    }
  });

  it("rejects stale revisions/previews and target conflicts, then explicitly resets", async () => {
    const agentId = await createAgent();
    const id = await start(agentId);
    const initial = await inspect(id);
    const updated = await edit(id, { ...initial.draft, name: "Designed name" });
    const stale = await user.patch<{ code: string }>(path(id), {
      revision: initial.revision,
      draft: initial.draft,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("design_changed");
    const oldPreview = await apply(id, initial.previewToken);
    expect(oldPreview.status).toBe(409);
    expect(oldPreview.body.code).toBe("preview_changed");
    expect(
      (
        await user.post("/api/agents", {
          id: agentId,
          name: "Manual change",
          config: { systemPrompt: "Manual prompt", model: "sonnet" },
        })
      ).status,
    ).toBe(201);
    expect((await inspect(id)).conflict).toBe(true);
    const conflict = await apply(id, updated.previewToken);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("target_changed");
    expect((await agent(agentId)).name).toBe("Manual change");
    const reset = await user.patch<View>(path(id), { revision: updated.revision, reset: true });
    expect(reset.status).toBe(200);
    expect(reset.body).toMatchObject({
      conflict: false,
      draft: { name: "Manual change", systemPrompt: "Manual prompt" },
    });
  });

  it("saves a draft without changing the published version or webhook", async () => {
    const agentId = await createAgent(user, { webhookUrl: "https://hooks.example.com/designer" });
    expect((await user.post(`/api/agents/${agentId}/versions`, { note: "Original" })).status).toBe(
      201,
    );
    const before = await user.get(`/api/agents/${agentId}/versions/1`);
    expect(before.status).toBe(200);
    const id = await start(agentId);
    const current = await inspect(id);
    const view = await edit(id, { ...current.draft, systemPrompt: "Unpublished" });
    expect((await apply(id, view.previewToken)).status).toBe(200);
    expect(await agent(agentId)).toMatchObject({
      publishedVersion: 1,
      webhookUrl: "https://hooks.example.com/designer",
      config: { systemPrompt: "Unpublished" },
    });
    const after = await user.get(`/api/agents/${agentId}/versions/1`);
    expect(after.status).toBe(200);
    expect(after.body).toEqual(before.body);
    const versions = await user.get<{
      versions: unknown[];
      hasUnpublishedChanges: boolean;
    }>(`/api/agents/${agentId}/versions`);
    expect(versions.body.versions).toHaveLength(1);
    expect(versions.body.hasUnpublishedChanges).toBe(true);
  });

  it("references existing resources without disclosing secrets; source changes invalidate preview", async () => {
    const config = {
      systemPrompt: "Resources",
      model: "sonnet",
      skillPackages: [
        {
          name: "report",
          description: "Report",
          files: { "SKILL.md": "# Existing skill", "scripts/run.sh": "private-script-marker" },
        },
      ],
      mcpServers: [
        {
          name: "search",
          type: "http",
          url: "https://mcp.example.com?token=secret-marker",
          env: { TOKEN: "private-env-marker" },
        },
      ],
    };
    const source = await createAgent(user, { config });
    const id = await start();
    const available = await edit(id, draft(), [source]);
    expect(available.resources).toHaveLength(2);
    const refs = {
      skillRefs: available.resources.filter((r) => r.kind === "skill").map((r) => r.ref),
      mcpRefs: available.resources.filter((r) => r.kind === "mcp").map((r) => r.ref),
    };
    const ready = await edit(id, { ...draft(), ...refs }, [source]);
    expect(ready.issues).toEqual([]);
    for (const marker of ["secret-marker", "private-env-marker", "private-script-marker"]) {
      expect(JSON.stringify(ready)).not.toContain(marker);
    }
    expect(
      (
        await user.post("/api/agents", {
          id: source,
          name: "Resources",
          config: {
            ...config,
            mcpServers: [{ ...config.mcpServers[0], url: "https://mcp.example.com/v2" }],
          },
        })
      ).status,
    ).toBe(201);
    const stale = await apply(id, ready.previewToken);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("preview_changed");
    const fresh = await inspect(id);
    expect(fresh.revision).toBe(ready.revision);
    const saved = await apply(id, fresh.previewToken);
    expect(saved.status).toBe(200);
    const final = await agent(saved.body.agent.id);
    expect(final.config.skillPackages).toEqual(config.skillPackages);
    expect(final.config.mcpServers?.[0]?.url).toBe("https://mcp.example.com/v2");
  });

  it("denies foreign/read-only source selection and unknown resource references", async () => {
    const source = await createAgent(other);
    const id = await start();
    const before = await inspect(id);
    expect(
      (
        await user.patch(path(id), {
          revision: before.revision,
          resourceAgentIds: [source],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await other.post(`/api/agents/${source}/share`, {
          target: "public",
          permission: "read",
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await user.patch(path(id), {
          revision: before.revision,
          resourceAgentIds: [source],
        })
      ).status,
    ).toBe(403);
    const invalid = await edit(id, { ...draft(), skillRefs: ['["unknown","skill","invented"]'] });
    expect(invalid.issues.length).toBeGreaterThan(0);
    const result = await apply(id, invalid.previewToken);
    expect(result.status).toBe(400);
    expect(result.body.code).toBe("invalid_config");
  });

  it.each([
    {
      skillPackages: [
        { name: "generated", files: { "SKILL.md": "# New", "scripts/run.sh": "echo new" } },
      ],
    },
    { mcpServers: [{ name: "injected", type: "http", url: "https://example.com" }] },
    { escapeHatch: { arbitrary: true } },
    { webhookUrl: "https://attacker.example.com" },
  ])("refuses generated skill packages and protected parameters: %j", async (parameters) => {
    const id = await start();
    const invalid = await edit(id, { ...draft(), parameters });
    expect(invalid.issues.length).toBeGreaterThan(0);
    const result = await apply(id, invalid.previewToken);
    expect(result.status).toBe(400);
    expect(result.body.code).toBe("invalid_config");
  });
});
