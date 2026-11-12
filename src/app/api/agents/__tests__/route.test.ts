// 智能体列表与创建:工作室需要的字段(是否本人所有、近 7 天运行数、更新时间)与「只新建」保护。

import { beforeEach, describe, expect, it, vi } from "vitest";

const DAY = 24 * 60 * 60 * 1000;

const mk = (id: string, ownerId: string, extra: Record<string, unknown> = {}) => ({
  id,
  ownerId,
  name: id,
  config: { systemPrompt: "p", model: "sonnet", maxTurns: 20 },
  ...extra,
});

const state = vi.hoisted(() => ({
  agents: [] as Record<string, unknown>[],
  grants: [] as Record<string, unknown>[],
  taken: new Set<string>(),
  activityCalls: [] as { ids: string[]; since: number }[],
  upserts: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/container", () => ({
  getContainer: () => ({
    auth: {
      resolveWeb: async () => ({ type: "web", userId: "me", role: "user" }),
      subjectOf: async () => ({ userId: "me", role: "user" }),
      assertCanManageAgents: () => {},
    },
    env: { allowStdioMcp: false, webhookAllowPrivate: false },
    grants: {
      listForType: async () => state.grants,
      listForResource: async () => state.grants,
    },
    agents: {
      list: async () => state.agents,
      get: async (id: string) => state.agents.find((a) => a.id === id) ?? null,
      idTaken: async (id: string) => state.taken.has(id),
      upsert: async (a: Record<string, unknown>) => {
        state.upserts.push(a);
        return a;
      },
    },
    releases: {
      publishedOf: async (list: { id: string; publishedVersion?: number; name: string }[]) =>
        new Map(
          list
            .filter((a) => a.publishedVersion)
            .map((a) => [
              a.id,
              { version: a.publishedVersion, name: a.name, config: { model: "sonnet" } },
            ]),
        ),
      hasUnpublishedChanges: () => false,
    },
    agentActivity: {
      of: async (ids: string[], since: number) => {
        state.activityCalls.push({ ids, since });
        return new Map(ids.map((id, i) => [id, { runs: i + 3, updatedAt: 1_700_000_000_000 + i }]));
      },
    },
    audit: { record: async () => {} },
    modelCatalogView: async () => undefined,
  }),
}));

beforeEach(() => {
  state.agents = [];
  state.grants = [];
  state.taken = new Set();
  state.activityCalls = [];
  state.upserts = [];
});

async function list() {
  const { GET } = await import("../route");
  const res = await GET(new Request("http://x/api/agents"));
  return (await res.json()) as { agents: Record<string, unknown>[] };
}

describe("GET /api/agents —— 工作室字段", () => {
  it("标出是否本人所有,带近 7 天运行数与更新时间,一次查询取齐", async () => {
    state.agents = [
      mk("mine", "me"),
      mk("shared", "other"),
      mk("listed", "author", { marketListed: true, publishedVersion: 2 }),
    ];
    state.grants = [
      {
        id: "g1",
        resourceType: "agent",
        resourceId: "shared",
        principalType: "user",
        principalId: "me",
        permission: "read",
      },
    ];
    const before = Date.now();
    const { agents } = await list();
    const by = new Map(agents.map((a) => [a.id, a]));

    expect(by.get("mine")).toMatchObject({
      isOwner: true,
      runs7d: 3,
      updatedAt: 1_700_000_000_000,
    });
    expect(by.get("shared")).toMatchObject({ isOwner: false, runs7d: 4, canWrite: false });
    // 只有市场使用权的条目是白名单摘要,不带这些字段
    expect(by.get("listed")).toMatchObject({ canRead: false });
    expect(by.get("listed")).not.toHaveProperty("runs7d");
    expect(by.get("listed")).not.toHaveProperty("isOwner");

    expect(state.activityCalls).toHaveLength(1);
    expect(state.activityCalls[0]?.ids).toEqual(["mine", "shared"]);
    const since = state.activityCalls[0]?.since ?? 0;
    expect(since).toBeGreaterThanOrEqual(before - 7 * DAY - 1000);
    expect(since).toBeLessThanOrEqual(Date.now() - 7 * DAY);
  });

  it("没有可见的智能体时不查运行统计", async () => {
    const { agents } = await list();
    expect(agents).toEqual([]);
    expect(state.activityCalls).toHaveLength(0);
  });
});

async function create(body: Record<string, unknown>) {
  const { POST } = await import("../route");
  const res = await POST(
    new Request("http://x/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("POST /api/agents —— createOnly", () => {
  const base = { name: "新的", config: { systemPrompt: "p" } };

  it("只新建时,已被占用的 ID(含已删除的)直接 409,不改动已有智能体", async () => {
    state.agents = [mk("taken", "me")];
    state.taken = new Set(["taken", "deleted-one"]);
    for (const id of ["taken", "deleted-one"]) {
      const r = await create({ ...base, id, createOnly: true });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe("id_taken");
      expect(String(r.body.error)).toContain("已被占用");
    }
    expect(state.upserts).toHaveLength(0);
  });

  it("只新建且 ID 空闲时正常创建", async () => {
    const r = await create({ ...base, id: "fresh-one", createOnly: true });
    expect(r.status).toBe(201);
    expect(state.upserts[0]).toMatchObject({ id: "fresh-one", ownerId: "me", name: "新的" });
  });

  it("不带 createOnly 时保存已有智能体的行为不变", async () => {
    state.agents = [mk("taken", "me")];
    state.taken = new Set(["taken"]);
    const r = await create({ ...base, id: "taken" });
    expect(r.status).toBe(201);
    expect(state.upserts).toHaveLength(1);
  });
});

describe("乐观锁:自动保存不能静默覆盖别处的修改", () => {
  const save = (extra: Record<string, unknown>) =>
    create({ id: "a1", name: "a1", config: { systemPrompt: "p" }, ...extra });

  it("列表给每个可读的智能体带上 revision", async () => {
    state.agents = [mk("a1", "me")];
    const body = await list();
    expect(typeof body.agents[0]?.revision).toBe("string");
    expect(String(body.agents[0]?.revision).length).toBeGreaterThan(8);
  });

  it("expectedRevision 与库里当前版本一致才保存,并返回新的 revision", async () => {
    state.agents = [mk("a1", "me")];
    const rev = (await list()).agents[0]?.revision;
    const r = await save({ expectedRevision: rev });
    expect(r.status).toBe(201);
    expect(state.upserts).toHaveLength(1);
    expect(typeof (r.body.agent as Record<string, unknown>).revision).toBe("string");
  });

  it("库里已被别处改过(revision 对不上)时 409 stale_draft,不写库", async () => {
    state.agents = [mk("a1", "me")];
    const rev = (await list()).agents[0]?.revision;
    // 另一个标签页 / 协作者 / 智能体设计器把提示词改了
    state.agents = [mk("a1", "me", { config: { systemPrompt: "别处改的", model: "sonnet" } })];
    const r = await save({ expectedRevision: rev });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("stale_draft");
    expect(state.upserts).toHaveLength(0);
  });

  it("不带 expectedRevision 的调用方(脚本、旧客户端)行为不变", async () => {
    state.agents = [mk("a1", "me", { config: { systemPrompt: "别处改的", model: "sonnet" } })];
    const r = await save({});
    expect(r.status).toBe(201);
  });
});
