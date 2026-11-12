// POST /api/sessions 的试聊会话(trial: true):构建页用草稿对话,来源记 trial,不进 /chat 普通列表。
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  created: [] as Record<string, unknown>[],
  grants: [] as Record<string, unknown>[],
}));

const agent = {
  id: "a1",
  ownerId: "author",
  name: "A1",
  publishedVersion: 3,
  config: { systemPrompt: "p", model: "sonnet" },
};

vi.mock("@/lib/container", () => ({
  getContainer: () => ({
    env: { dataDir: path.join(os.tmpdir(), "owa-trial-route-test") },
    auth: {
      resolveWeb: async (req: Request) => {
        const key = req.headers.get("x-test-key");
        if (key) return { type: "apiKey", keyId: key, ownerId: "author" };
        return { type: "web", userId: req.headers.get("x-test-user") ?? "anon", role: "user" };
      },
      subjectOf: async (p: { userId: string }) => ({ userId: p.userId, role: "user" }),
      assertCanInvoke: async () => {},
    },
    agents: { get: async (id: string) => (id === agent.id ? agent : null) },
    grants: { listForResource: async () => state.grants },
    releases: {
      resolve: async () => ({ version: 3 }),
      modelsOf: async () => new Map<string, string>(),
    },
    sessions: {
      create: async (s: Record<string, unknown>) => {
        state.created.push(s);
        return { ...s, status: "active", createdAt: 1 };
      },
    },
  }),
}));

beforeEach(() => {
  state.created = [];
  state.grants = [];
});

async function post(body: unknown, headers: Record<string, string>) {
  const { POST } = await import("../route");
  return POST(
    new Request("http://x/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/sessions trial", () => {
  it("有写权限的登录用户:建试聊会话,source=trial,跑草稿(无 agentVersion),归属与计费为本人", async () => {
    const res = await post({ agentId: "a1", trial: true }, { "x-test-user": "author" });
    expect(res.status).toBe(201);
    expect(state.created).toHaveLength(1);
    const s = state.created[0];
    expect(s).toMatchObject({
      agentId: "a1",
      source: "trial",
      ownerId: "author",
      billingUserId: "author",
    });
    expect(s?.agentVersion).toBeUndefined();
    expect(s?.callerApiKeyId).toBeUndefined();
  });

  it("显式要求 published 也不行:试聊固定跑草稿", async () => {
    const res = await post(
      { agentId: "a1", trial: true, versionMode: "published" },
      { "x-test-user": "author" },
    );
    expect(res.status).toBe(400);
    expect(state.created).toHaveLength(0);
  });

  it("对该智能体没有写权限:403 forbidden,不建会话", async () => {
    const res = await post({ agentId: "a1", trial: true }, { "x-test-user": "stranger" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("forbidden");
    expect(state.created).toHaveLength(0);
  });

  it("API Key 调用不能建试聊会话:403", async () => {
    const res = await post({ agentId: "a1", trial: true }, { "x-test-key": "k1" });
    expect(res.status).toBe(403);
    expect(state.created).toHaveLength(0);
  });

  it("trial 只接受布尔 true", async () => {
    const res = await post({ agentId: "a1", trial: "yes" }, { "x-test-user": "author" });
    expect(res.status).toBe(400);
    expect(state.created).toHaveLength(0);
  });

  it("不带 trial 时行为不变:作者跟随草稿,来源 web", async () => {
    const res = await post({ agentId: "a1" }, { "x-test-user": "author" });
    expect(res.status).toBe(201);
    expect(state.created[0]).toMatchObject({ source: "web", ownerId: "author" });
    expect(state.created[0]?.agentVersion).toBeUndefined();
  });
});
