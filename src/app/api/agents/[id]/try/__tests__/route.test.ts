// 构建页在线试调:POST /api/agents/[id]/try 受理(网页登录、复用 invoke 的受理核心),
// GET ?runId= 取结果(与 result 同一份契约,但只看本智能体、本人可访问的运行)。
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  sessions: new Map<string, Record<string, unknown>>(),
  runs: new Map<string, Record<string, unknown>>(),
  enqueued: [] as Record<string, unknown>[],
  rateKeys: [] as string[],
  enqueueError: undefined as unknown,
}));

const agent = {
  id: "a1",
  ownerId: "me",
  name: "A1",
  config: {
    systemPrompt: "p",
    model: "sonnet",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
};

vi.mock("@/lib/container", async () => {
  const { Forbidden, Unauthorized } = await import("@/lib/modules/access/application/authorize");
  return {
    getContainer: () => ({
      env: {
        dataDir: path.join(os.tmpdir(), "owa-try-route-test"),
        invokeRateLimitPerKey: 60,
        invokeRateLimitPerAgent: 600,
        webhookAllowPrivate: false,
      },
      auth: {
        resolveWeb: async (req: Request) => {
          const key = req.headers.get("x-test-key");
          if (key) return { type: "apiKey", keyId: key, ownerId: "me" };
          const user = req.headers.get("x-test-user");
          if (!user) throw new Unauthorized("login required");
          return { type: "web", userId: user, role: "user" };
        },
        assertCanInvoke: async (p: { userId?: string }, agentId: string) => {
          if (agentId !== "a1" && agentId !== "a2") throw new Forbidden("no access");
          if (p.userId === "stranger") throw new Forbidden("no access");
        },
        assertSessionAccess: async (p: { userId?: string }, sessionId: string) => {
          const s = state.sessions.get(sessionId);
          if (!s || s.ownerId !== p.userId) throw new Forbidden("no access");
        },
      },
      agents: { get: async (id: string) => (id === "a1" ? agent : null) },
      releases: { resolve: async () => ({ version: null, config: agent.config }) },
      rateLimiter: {
        hit: async (key: string) => {
          state.rateKeys.push(key);
          return { allowed: true, retryAfterMs: 0, remaining: 59, resetMs: 60_000 };
        },
      },
      modelCatalogView: async () => undefined,
      storage: { write: async () => {}, tree: async () => [] },
      sessions: {
        create: async (s: Record<string, unknown>) => {
          state.sessions.set(s.id as string, s);
          return s;
        },
        get: async (id: string) => state.sessions.get(id) ?? null,
        delete: async (id: string) => {
          state.sessions.delete(id);
        },
      },
      runs: {
        findByIdempotencyKey: async () => null,
        get: async (id: string) => state.runs.get(id) ?? null,
        getResult: async (id: string) => state.runs.get(id) ?? null,
      },
      enqueuer: {
        enqueue: async (r: Record<string, unknown>) => {
          if (state.enqueueError) throw state.enqueueError;
          state.enqueued.push(r);
        },
      },
    }),
  };
});

beforeEach(() => {
  state.sessions = new Map();
  state.runs = new Map();
  state.enqueued = [];
  state.rateKeys = [];
  state.enqueueError = undefined;
});

const params = (id = "a1") => ({ params: Promise.resolve({ id }) });

async function post(body: unknown, headers: Record<string, string> = { "x-test-user": "me" }) {
  const { POST } = await import("../route");
  return POST(
    new Request("http://x/api/agents/a1/try", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    params(),
  );
}

async function get(
  query: string,
  headers: Record<string, string> = { "x-test-user": "me" },
  id = "a1",
) {
  const { GET } = await import("../route");
  return GET(new Request(`http://x/api/agents/${id}/try${query}`, { headers }), params(id));
}

describe("POST /api/agents/[id]/try", () => {
  it("未登录 401;API Key 调用 403", async () => {
    expect((await post({ input: { query: "q" } }, {})).status).toBe(401);
    const res = await post({ input: { query: "q" } }, { "x-test-key": "k1" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("forbidden");
    expect(state.enqueued).toHaveLength(0);
  });

  it("无权调用该智能体 403", async () => {
    expect((await post({ input: { query: "q" } }, { "x-test-user": "stranger" })).status).toBe(403);
  });

  it("input 不符合 inputSchema:400 input_invalid 带 details", async () => {
    const res = await post({ input: { wrong: 1 } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; details?: unknown[] };
    expect(body.code).toBe("input_invalid");
    expect(Array.isArray(body.details)).toBe(true);
    expect(state.enqueued).toHaveLength(0);
  });

  it("成功 202:会话记为接口调用,归属与计费为本人,限流按 user:<id>,不投递 webhook", async () => {
    const res = await post({ input: { query: "hello" } });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["agentVersion", "sessionId", "structured", "taskId"]);
    expect(body).toMatchObject({ structured: false, agentVersion: null });
    const s = state.sessions.get(body.sessionId as string);
    expect(s).toMatchObject({
      agentId: "a1",
      source: "invoke",
      ownerId: "me",
      billingUserId: "me",
      unattended: true,
    });
    expect(s?.callerApiKeyId).toBeUndefined();
    expect(state.enqueued[0]).toMatchObject({ runId: body.taskId, noCallback: true });
    expect(state.rateKeys).toContain("invoke:key:user:me");
  });

  it("不支持 Idempotency-Key 与 callbackUrl:400 invalid_request", async () => {
    const a = await post(
      { input: { query: "q" } },
      { "x-test-user": "me", "Idempotency-Key": "k" },
    );
    expect(a.status).toBe(400);
    expect(((await a.json()) as { code: string }).code).toBe("invalid_request");
    const b = await post({ input: { query: "q" }, callbackUrl: "https://example.com/hook" });
    expect(b.status).toBe(400);
    expect(state.enqueued).toHaveLength(0);
  });

  it("余额不足 402(与 invoke 同一错误码),回滚刚建的会话", async () => {
    const { ChargeRejected } = await import("@/lib/modules/billing/application/run-charging");
    state.enqueueError = new ChargeRejected("insufficient_balance");
    const res = await post({ input: { query: "q" } });
    expect(res.status).toBe(402);
    expect(((await res.json()) as { code: string }).code).toBe("insufficient_balance");
    expect(state.sessions.size).toBe(0);
  });

  it("智能体不存在 404", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      new Request("http://x/api/agents/a2/try", {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-user": "me" },
        body: JSON.stringify({ input: "hi" }),
      }),
      params("a2"),
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /api/agents/[id]/try?runId=", () => {
  beforeEach(() => {
    state.sessions.set("s1", { id: "s1", agentId: "a1", ownerId: "me", workspaceDir: "/ws/s1" });
    state.sessions.set("s2", { id: "s2", agentId: "a2", ownerId: "me", workspaceDir: "/ws/s2" });
    state.sessions.set("s3", { id: "s3", agentId: "a1", ownerId: "other", workspaceDir: "/ws/s3" });
    const run = (id: string, sessionId: string) => ({
      id,
      sessionId,
      status: "running",
      finalText: "partial",
    });
    state.runs.set("r1", run("r1", "s1"));
    state.runs.set("r2", run("r2", "s2"));
    state.runs.set("r3", run("r3", "s3"));
  });

  it("本智能体、本人的运行:与 result 同一契约", async () => {
    const res = await get("?runId=r1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      taskId: "r1",
      status: "running",
      done: false,
      text: "partial",
      summary: "partial",
      files: null,
      filesTruncated: false,
    });
  });

  it("别的智能体的运行 404;别人的会话 404;不存在 404;缺 runId 400", async () => {
    expect((await get("?runId=r2")).status).toBe(404);
    expect((await get("?runId=r3")).status).toBe(404);
    expect((await get("?runId=nope")).status).toBe(404);
    expect((await get("")).status).toBe(400);
  });

  it("API Key 调用 403,未登录 401", async () => {
    expect((await get("?runId=r1", { "x-test-key": "k1" })).status).toBe(403);
    expect((await get("?runId=r1", {})).status).toBe(401);
  });
});
