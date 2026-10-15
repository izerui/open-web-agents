import { Forbidden, Unauthorized } from "@/lib/modules/access/application/authorize";
import { VariableSizeExceeded } from "@/lib/modules/agent/adapters/mysql-variable-repo";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  authenticated: true,
  userId: "user-a",
  apiKey: false,
}));

const storedValues: Record<string, Record<string, Record<string, string>>> = {};
const agents: Record<
  string,
  { ownerId: string; config: { variables?: unknown[] }; publishedVersion?: number }
> = {};
const versions: Record<string, { config: { variables?: unknown[] } }> = {};
const sessionData: Record<
  string,
  { agentId: string; ownerId: string; agentVersion?: number; status?: string }
> = {};

vi.mock("@/lib/container", () => ({
  getContainer: () => ({
    agents: {
      get: async (id: string) => agents[id] ?? null,
    },
    grants: {
      listForResource: async () => [],
    },
    releases: {
      get: async (_id: string, version: number) => versions[`${_id}:${version}`] ?? null,
    },
    sessions: {
      get: async (id: string) => sessionData[id] ?? null,
    },
    variables: {
      get: async (agentId: string, userId: string) =>
        storedValues[agentId]?.[userId] ? { ...storedValues[agentId][userId] } : {},
      set: async (agentId: string, userId: string, values: Record<string, string>) => {
        if (!storedValues[agentId]) storedValues[agentId] = {};
        storedValues[agentId][userId] = { ...values };
      },
      merge: async (agentId: string, userId: string, updates: Record<string, string | null>) => {
        if (!storedValues[agentId]) storedValues[agentId] = {};
        const existing = storedValues[agentId][userId] ?? {};
        const merged = { ...existing };
        for (const [k, v] of Object.entries(updates)) {
          if (v === null) delete merged[k];
          else merged[k] = v;
        }
        if (JSON.stringify(merged).length > 500_000) throw new VariableSizeExceeded();
        storedValues[agentId][userId] = merged;
        return merged;
      },
    },
    auth: {
      resolveWeb: async () => {
        if (!state.authenticated) throw new Unauthorized("login");
        return state.apiKey
          ? { type: "apiKey" as const, ownerId: state.userId }
          : { type: "web" as const, userId: state.userId, role: "user" };
      },
      subjectOf: async () => ({ userId: state.userId }),
      assertSessionAccess: async (_p: unknown, sessionId: string) => {
        const s = sessionData[sessionId];
        if (!s || s.ownerId !== state.userId) throw new Forbidden("no session access");
      },
    },
  }),
}));

import { GET, PUT } from "../route";

const get = (id: string, opts?: { version?: number; sessionId?: string }) => {
  const params = new URLSearchParams();
  if (opts?.version) params.set("version", String(opts.version));
  if (opts?.sessionId) params.set("sessionId", opts.sessionId);
  const qs = params.toString();
  const url = `http://test/api/agents/${id}/variables${qs ? `?${qs}` : ""}`;
  return GET(new Request(url), { params: Promise.resolve({ id }) });
};

const put = (id: string, body: Record<string, unknown>) =>
  PUT(
    new Request(`http://test/api/agents/${id}/variables`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

describe("variable API version and secret safety", () => {
  beforeEach(() => {
    state.authenticated = true;
    state.userId = "user-a";
    state.apiKey = false;
    for (const k of Object.keys(storedValues)) delete storedValues[k];
    for (const k of Object.keys(agents)) delete agents[k];
    for (const k of Object.keys(versions)) delete versions[k];
    for (const k of Object.keys(sessionData)) delete sessionData[k];
  });

  it("saving *** for any key preserves the original value", async () => {
    agents.a1 = {
      ownerId: "user-a",
      config: { variables: [{ name: "KEY", required: true, secret: true }] },
    };
    storedValues.a1 = { "user-a": { KEY: "real-secret-value" } };

    expect((await put("a1", { KEY: "***" })).status).toBe(200);
    expect(storedValues.a1?.["user-a"]?.KEY).toBe("real-secret-value");
  });

  it("PUT does not delete keys not included in the request body", async () => {
    agents.a1 = {
      ownerId: "user-a",
      config: {
        variables: [
          { name: "A", required: true, secret: false },
          { name: "B", required: true, secret: true },
        ],
      },
    };
    storedValues.a1 = { "user-a": { A: "old-a", B: "old-b" } };

    expect((await put("a1", { A: "new-a" })).status).toBe(200);
    expect(storedValues.a1?.["user-a"]).toEqual({ A: "new-a", B: "old-b" });
  });

  it("v1 session variables survive after publishing v2 with different definitions", async () => {
    agents.a1 = {
      ownerId: "user-a",
      publishedVersion: 2,
      config: { variables: [{ name: "NEW_KEY", required: true, secret: true }] },
    };
    versions["a1:1"] = {
      config: { variables: [{ name: "OLD_KEY", required: true, secret: true }] },
    };
    versions["a1:2"] = {
      config: { variables: [{ name: "NEW_KEY", required: true, secret: true }] },
    };
    storedValues.a1 = { "user-a": { OLD_KEY: "old-secret", NEW_KEY: "new-secret" } };

    // GET with version=1 returns OLD_KEY definition
    const v1Res = await get("a1", { version: 1 });
    expect(v1Res.status).toBe(200);
    const v1Body = (await v1Res.json()) as {
      variables: { name: string }[];
      values: Record<string, string>;
    };
    expect(v1Body.variables.map((v) => v.name)).toEqual(["OLD_KEY"]);
    expect(v1Body.values.OLD_KEY).toBe("***");

    // GET with version=2 returns NEW_KEY definition
    const v2Res = await get("a1", { version: 2 });
    const v2Body = (await v2Res.json()) as {
      variables: { name: string }[];
      values: Record<string, string>;
    };
    expect(v2Body.variables.map((v) => v.name)).toEqual(["NEW_KEY"]);
    expect(v2Body.values.NEW_KEY).toBe("***");

    // PUT new value for NEW_KEY does NOT delete OLD_KEY
    expect((await put("a1", { NEW_KEY: "updated-new" })).status).toBe(200);
    expect(storedValues.a1?.["user-a"]?.OLD_KEY).toBe("old-secret");
    expect(storedValues.a1?.["user-a"]?.NEW_KEY).toBe("updated-new");
  });

  it("secret=true in published version but secret=false in draft: *** still preserves value", async () => {
    agents.a1 = {
      ownerId: "user-a",
      publishedVersion: 1,
      config: { variables: [{ name: "KEY", required: true, secret: false }] },
    };
    versions["a1:1"] = {
      config: { variables: [{ name: "KEY", required: true, secret: true }] },
    };
    storedValues.a1 = { "user-a": { KEY: "real-secret" } };

    // Owner GETs — sees draft where secret=false, so value is shown
    const ownerGet = await get("a1");
    const ownerBody = (await ownerGet.json()) as { values: Record<string, string> };
    expect(ownerBody.values.KEY).toBe("real-secret");

    // PUT *** — still preserved regardless of draft's secret flag
    expect((await put("a1", { KEY: "***" })).status).toBe(200);
    expect(storedValues.a1?.["user-a"]?.KEY).toBe("real-secret");
  });

  it("sessionId returns the session's locked version definitions, not current draft", async () => {
    agents.a1 = {
      ownerId: "user-a",
      publishedVersion: 2,
      config: { variables: [{ name: "NEW_KEY", required: true, secret: true }] },
    };
    versions["a1:1"] = {
      config: { variables: [{ name: "OLD_KEY", required: true, secret: true }] },
    };
    versions["a1:2"] = {
      config: { variables: [{ name: "NEW_KEY", required: true, secret: true }] },
    };
    sessionData["s-v1"] = { agentId: "a1", ownerId: "user-a", agentVersion: 1 };
    sessionData["s-v2"] = { agentId: "a1", ownerId: "user-a", agentVersion: 2 };
    storedValues.a1 = { "user-a": { OLD_KEY: "old-val", NEW_KEY: "new-val" } };

    const v1 = await get("a1", { sessionId: "s-v1" });
    expect(v1.status).toBe(200);
    const v1Body = (await v1.json()) as { variables: { name: string }[] };
    expect(v1Body.variables.map((v) => v.name)).toEqual(["OLD_KEY"]);

    const v2 = await get("a1", { sessionId: "s-v2" });
    const v2Body = (await v2.json()) as { variables: { name: string }[] };
    expect(v2Body.variables.map((v) => v.name)).toEqual(["NEW_KEY"]);
  });

  it("rejects another user's session", async () => {
    agents.a1 = {
      ownerId: "user-a",
      config: { variables: [{ name: "K", required: true, secret: true }] },
    };
    sessionData["s-other"] = { agentId: "a1", ownerId: "other-user", agentVersion: 1 };

    const res = await get("a1", { sessionId: "s-other" });
    expect(res.status).toBe(403);
  });

  it("PUT size limit triggers rollback — original values unchanged", async () => {
    agents.a1 = {
      ownerId: "user-a",
      config: { variables: [{ name: "K", required: false, secret: false }] },
    };
    storedValues.a1 = { "user-a": { K: "original" } };

    const hugeValue = "x".repeat(4000);
    const hugeBody: Record<string, string> = {};
    for (let i = 0; i < 200; i++) hugeBody[`VAR_${i}`] = hugeValue;

    const res = await put("a1", hugeBody);
    expect(res.status).toBe(400);
    expect(storedValues.a1?.["user-a"]?.K).toBe("original");
  });
});
