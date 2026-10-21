// 智能体版本与发布的端到端回归。
//
// 核心承诺:草稿怎么改都不影响对外调用方;发布后调用方拿到新版,回滚秒级生效;
// 入参校验、结果、运行记录都对得上实际执行的那一版。这些都只有从 HTTP 入口打进来才测得出。

import { beforeAll, describe, expect, it } from "vitest";
import { Client, newUser, passDraftEval, serverUp } from "./client";

type AgentRes = { agent?: { id: string }; error?: string };
type ListRes = {
  agents?: {
    id: string;
    name: string;
    config: { systemPrompt?: string; inputSchema?: unknown };
    publishedVersion?: number | null;
    hasUnpublishedChanges?: boolean;
    published?: { version: number; inputSchema?: unknown } | null;
  }[];
};
type VersionsRes = {
  publishedVersion?: number | null;
  hasUnpublishedChanges?: boolean;
  versions?: { version: number; note?: string }[];
};
type InvokeRes = { taskId?: string; agentVersion?: number | null; code?: string; error?: string };
type ResultRes = { agentVersion?: number | null };

const schemaA = {
  type: "object",
  required: ["a"],
  properties: { a: { type: "string" } },
  additionalProperties: false,
};
const schemaB = {
  type: "object",
  required: ["b"],
  properties: { b: { type: "integer" } },
  additionalProperties: false,
};

describe("智能体版本与发布", () => {
  let owner: Client;
  let reader: Client;
  let stranger: Client;
  let agentId = "";
  let key = "";
  const anon = new Client("anon");

  const save = (systemPrompt: string, inputSchema: unknown, name = "版本测试") =>
    owner.post<AgentRes>("/api/agents", {
      id: agentId || undefined,
      name,
      config: { systemPrompt, model: "sonnet", inputSchema },
    });
  const invoke = (body: unknown, headers: Record<string, string> = {}) =>
    anon.post<InvokeRes>(`/api/agents/${agentId}/invoke`, body, { "X-Api-Key": key, ...headers });
  const versions = (c: Client = owner) => c.get<VersionsRes>(`/api/agents/${agentId}/versions`);
  const mine = async () =>
    (await owner.get<ListRes>("/api/agents")).body.agents?.find((a) => a.id === agentId);

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
    owner = await newUser("ver-owner");
    reader = await newUser("ver-reader");
    stranger = await newUser("ver-stranger");
    agentId = (await save("v1 提示词", schemaA)).body.agent?.id ?? "";
    key =
      (await owner.post<{ plaintext?: string }>("/api/keys", { name: "ver", agentId })).body
        .plaintext ?? "";
    const readerEmail = (await reader.get<{ user?: { email: string } }>("/api/auth")).body.user
      ?.email;
    const share = await owner.post(`/api/agents/${agentId}/share`, {
      target: readerEmail,
      permission: "read",
    });
    expect(share.status).toBe(201);
  });

  it("从未发布:调用跑草稿(agentVersion 为 null),版本列表为空", async () => {
    const r = await invoke({ input: { a: "x" } });
    expect(r.status).toBe(202);
    expect(r.body.agentVersion).toBeNull();
    const v = await versions();
    expect(v.body.publishedVersion).toBeNull();
    expect(v.body.versions).toEqual([]);
  });

  it("发布 v1;草稿没改时再发布返回 409 nothing_to_publish", { timeout: 60_000 }, async () => {
    await passDraftEval(owner, agentId, { a: "门槛" });
    const p = await owner.post<{ version?: { version: number } }>(
      `/api/agents/${agentId}/versions`,
      { note: "首版" },
    );
    expect(p.status).toBe(201);
    expect(p.body.version?.version).toBe(1);
    const again = await owner.post<{ code?: string }>(`/api/agents/${agentId}/versions`, {});
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("nothing_to_publish");
  });

  it("改草稿(换成新的 inputSchema):调用方仍按 v1 的契约校验并执行 v1", async () => {
    expect((await save("v2 提示词", schemaB)).status).toBe(201);
    const a = await mine();
    expect(a?.publishedVersion).toBe(1);
    expect(a?.hasUnpublishedChanges).toBe(true);
    expect(a?.published?.inputSchema).toEqual(schemaA);

    const ok = await invoke({ input: { a: "按 v1 的契约" } });
    expect(ok.status).toBe(202);
    expect(ok.body.agentVersion).toBe(1);
    // 草稿的新契约还没发布,调用方按它传会被 v1 拒绝
    expect((await invoke({ input: { b: 1 } })).body.code).toBe("input_invalid");

    // 结果与运行记录都记着 v1
    const res = await anon.get<ResultRes>(`/api/agents/${ok.body.taskId}/result`, {
      "X-Api-Key": key,
    });
    expect(res.body.agentVersion).toBe(1);
    const runs = await owner.get<{ items?: { id: string; agentVersion?: number }[] }>(
      "/api/runs?source=invoke",
    );
    expect(runs.body.items?.find((r) => r.id === ok.body.taskId)?.agentVersion).toBe(1);
  });

  it("只读者看到的是已发布版本;作者看到草稿", async () => {
    const forReader = (await reader.get<ListRes>("/api/agents")).body.agents?.find(
      (a) => a.id === agentId,
    );
    expect(forReader?.config.systemPrompt).toBe("v1 提示词");
    expect(forReader?.hasUnpublishedChanges).toBeUndefined();
    expect((await mine())?.config.systemPrompt).toBe("v2 提示词");
  });

  it("网页会话:只读者锁定已发布版本,作者跟随草稿", async () => {
    type S = { session?: { agentVersion?: number } };
    const r = await reader.post<S>("/api/sessions", { agentId });
    expect(r.body.session?.agentVersion).toBe(1);
    const o = await owner.post<S>("/api/sessions", { agentId });
    expect(o.body.session?.agentVersion).toBeUndefined();
  });

  it("发布 v2 后调用切到 v2;显式 version 可锁定旧版;不存在的版本 404,非法 400", async () => {
    await passDraftEval(owner, agentId, { b: 1 });
    const p = await owner.post(`/api/agents/${agentId}/versions`, { note: "换契约" });
    expect(p.status).toBe(201);
    const latest = await invoke({ input: { b: 2 } });
    expect(latest.status).toBe(202);
    expect(latest.body.agentVersion).toBe(2);

    const pinned = await invoke({ input: { a: "锁定 v1" }, version: 1 });
    expect(pinned.status).toBe(202);
    expect(pinned.body.agentVersion).toBe(1);

    expect((await invoke({ input: { b: 1 }, version: 9 })).status).toBe(404);
    expect((await invoke({ input: { b: 1 }, version: "v1" })).status).toBe(400);
  });

  it("同一个幂等键换了 version 是不同的请求:422", async () => {
    const k = `ver-${Date.now()}`;
    expect((await invoke({ input: { a: "x" }, version: 1 }, { "Idempotency-Key": k })).status).toBe(
      202,
    );
    const r = await invoke({ input: { b: 1 }, version: 2 }, { "Idempotency-Key": k });
    expect(r.status).toBe(422);
  });

  it("回滚到 v1:默认调用立刻改跑 v1", async () => {
    const r = await owner.post(`/api/agents/${agentId}/versions/1/activate`, {});
    expect(r.status).toBe(200);
    const after = await invoke({ input: { a: "回滚后" } });
    expect(after.status).toBe(202);
    expect(after.body.agentVersion).toBe(1);
    expect((await versions()).body.publishedVersion).toBe(1);
  });

  it("OpenAPI 文档描述当前发布的版本", async () => {
    const doc = await owner.get<{ info?: { version?: string } }>(
      `/api/agents/${agentId}/openapi.json`,
    );
    expect(doc.body.info?.version).toBe("v1");
  });

  it("载入草稿:草稿换成 v1 的内容,发布版本不变", async () => {
    const r = await owner.post(`/api/agents/${agentId}/versions/1/restore`, {});
    expect(r.status).toBe(200);
    const a = await mine();
    expect(a?.config.systemPrompt).toBe("v1 提示词");
    expect(a?.publishedVersion).toBe(1);
    expect(a?.hasUnpublishedChanges).toBe(false);
  });

  it("权限:只读者能看版本但不能发布/回滚;无关的人 404;API Key 不能发布", async () => {
    expect((await versions(reader)).status).toBe(200);
    expect((await reader.post(`/api/agents/${agentId}/versions`, {})).status).toBe(403);
    expect((await reader.post(`/api/agents/${agentId}/versions/2/activate`, {})).status).toBe(403);
    expect((await versions(stranger)).status).toBe(404);
    expect((await stranger.post(`/api/agents/${agentId}/versions`, {})).status).toBe(404);
    const byKey = await anon.post(`/api/agents/${agentId}/versions`, {}, { "X-Api-Key": key });
    expect([401, 403]).toContain(byKey.status);
  });
});

describe("API Key 的智能体绑定与只读边界", () => {
  type VersionDetail = {
    version?: {
      config?: { mcpServers?: { env?: Record<string, string> }[]; escapeHatch?: unknown };
    };
  };
  let owner: Client;
  let a = "";
  let b = "";
  let keyA = "";
  const anon = new Client("anon-bound");
  const withKey = () => ({ "X-Api-Key": keyA });

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
    owner = await newUser("bound-owner");
    const mk = async (name: string) =>
      (
        await owner.post<AgentRes>("/api/agents", {
          name,
          config: {
            systemPrompt: name,
            model: "sonnet",
            mcpServers: [
              {
                name: "files",
                type: "http",
                url: "https://mcp.example.com",
                env: { TOKEN: "s3cret" },
              },
            ],
          },
        })
      ).body.agent?.id ?? "";
    a = await mk("绑定-A");
    b = await mk("绑定-B");
    for (const id of [a, b]) {
      await passDraftEval(owner, id);
      expect((await owner.post(`/api/agents/${id}/versions`, {})).status).toBe(201);
    }
    keyA =
      (await owner.post<{ plaintext?: string }>("/api/keys", { name: "only-a", agentId: a })).body
        .plaintext ?? "";
  });

  it("A 专用 Key 读 B 的版本:404(与不存在不可区分)", async () => {
    expect((await anon.get(`/api/agents/${b}/versions`, withKey())).status).toBe(404);
    expect((await anon.get(`/api/agents/${b}/versions/1`, withKey())).status).toBe(404);
  });

  it("A 专用 Key 读 A 的版本详情:能读,但 MCP 环境变量脱敏、没有逃生舱字段", async () => {
    const r = await anon.get<VersionDetail>(`/api/agents/${a}/versions/1`, withKey());
    expect(r.status).toBe(200);
    expect(r.body.version?.config?.mcpServers?.[0]?.env).toEqual({ TOKEN: "***" });
    expect(JSON.stringify(r.body)).not.toContain("s3cret");
    expect(r.body.version?.config).not.toHaveProperty("escapeHatch");
    // 所有者在网页上看到的是原值 —— 脱敏是因为 Key,不是因为数据丢了
    const mine = await owner.get<VersionDetail>(`/api/agents/${a}/versions/1`);
    expect(mine.body.version?.config?.mcpServers?.[0]?.env).toEqual({ TOKEN: "s3cret" });
  });

  it("智能体列表:A 专用 Key 只看得到 A,且配置脱敏", async () => {
    const r = await anon.get<ListRes>("/api/agents", withKey());
    expect(r.status).toBe(200);
    expect(r.body.agents?.map((x) => x.id)).toEqual([a]);
    expect(JSON.stringify(r.body)).not.toContain("s3cret");
  });

  it("知识库与分享:Key 碰不到 B;对 A 也只能读、不能改", async () => {
    expect((await anon.get(`/api/agents/${b}/knowledge`, withKey())).status).toBe(404);
    expect((await anon.get(`/api/agents/${a}/knowledge`, withKey())).status).toBe(200);
    expect(
      (await anon.post(`/api/agents/${a}/knowledge`, { title: "t", content: "c" }, withKey()))
        .status,
    ).toBe(403);
    expect(
      (await anon.post(`/api/agents/${b}/share`, { target: "public" }, withKey())).status,
    ).toBe(404);
    expect(
      (await anon.post(`/api/agents/${a}/share`, { target: "public" }, withKey())).status,
    ).toBe(403);
  });
});

describe("幂等重放跨版本:v1 受理 → 发布不兼容的 v2 → 原键原请求重试", () => {
  it("仍返回原 taskId、原版本与原结果形态,而不是被 v2 的 schema 拒绝", async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
    const owner = await newUser("replay-owner");
    const save = (id: string | undefined, inputSchema: unknown, outputSchema?: unknown) =>
      owner.post<AgentRes>("/api/agents", {
        id,
        name: "重放",
        config: { systemPrompt: "p", model: "sonnet", inputSchema, outputSchema },
      });
    const id = (await save(undefined, schemaA)).body.agent?.id ?? "";
    await passDraftEval(owner, id, { a: "门槛" });
    expect((await owner.post(`/api/agents/${id}/versions`, {})).status).toBe(201);
    const key =
      (await owner.post<{ plaintext?: string }>("/api/keys", { name: "r", agentId: id })).body
        .plaintext ?? "";
    const anon = new Client("anon-replay");
    type R = InvokeRes & { structured?: boolean; replayed?: boolean };
    const call = () =>
      anon.post<R>(
        `/api/agents/${id}/invoke`,
        { input: { a: "首次" } },
        { "X-Api-Key": key, "Idempotency-Key": `replay-${id}` },
      );

    const first = await call();
    expect(first.status).toBe(202);
    expect(first.body.agentVersion).toBe(1);
    expect(first.body.structured).toBe(false);

    // v2:入参改成 schemaB(与原请求不兼容),并声明了 outputSchema
    await save(id, schemaB, { type: "object", properties: { ok: { type: "boolean" } } });
    await passDraftEval(owner, id, { b: 1 });
    expect((await owner.post(`/api/agents/${id}/versions`, {})).status).toBe(201);
    // 新请求确实会被 v2 拒绝 —— 证明下面的重放不是因为校验碰巧通过
    const fresh = await anon.post<R>(
      `/api/agents/${id}/invoke`,
      { input: { a: "新请求" } },
      { "X-Api-Key": key },
    );
    expect(fresh.status).toBe(400);

    const retry = await call();
    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBe(true);
    expect(retry.body.taskId).toBe(first.body.taskId);
    expect(retry.body.agentVersion).toBe(1);
    expect(retry.body.structured).toBe(false);
  });
});

describe("幂等重放先于额度:首次受理 → 额度耗尽 → 原键重试", () => {
  /*
   * e2e 建不出管理员,没法走接口设额度;这里直接改服务端库里【本用例刚注册的】账号。
   * 库地址只认 scripts/e2e.sh 导出的 OWA_E2E_DATABASE_URL(确知是服务正在用的库),
   * 没有就跳过并说明,不去猜。
   */
  const dbUrl = process.env.OWA_E2E_DATABASE_URL;
  if (!dbUrl) {
    console.warn(
      "[skip] 额度耗尽重放用例未运行 —— 需由 scripts/e2e.sh 起服务并设置 OWA_DATABASE_URL",
    );
  }

  it.skipIf(!dbUrl)("原键原请求仍返回原任务;新键请求按上限已满处理", async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
    const owner = await newUser("quota-owner");
    const email = (await owner.get<{ user?: { email: string } }>("/api/auth")).body.user?.email;
    expect(email).toBeTruthy();
    const id =
      (
        await owner.post<AgentRes>("/api/agents", {
          name: "额度重放",
          config: { systemPrompt: "p", model: "sonnet" },
        })
      ).body.agent?.id ?? "";
    const key =
      (await owner.post<{ plaintext?: string }>("/api/keys", { name: "q", agentId: id })).body
        .plaintext ?? "";
    const anon = new Client("anon-quota");
    type R = InvokeRes & { replayed?: boolean; code?: string };
    const call = (idemKey: string) =>
      anon.post<R>(
        `/api/agents/${id}/invoke`,
        { input: "同一个请求" },
        { "X-Api-Key": key, "Idempotency-Key": idemKey },
      );

    const first = await call(`quota-${id}`);
    expect(first.status).toBe(202);

    // 模拟"这次运行把额度用完了":额度设为 0(已用 >= 上限即耗尽)
    const mysql = await import("mysql2/promise");
    const conn = await mysql.createConnection(dbUrl as string);
    try {
      const [res] = await conn.execute(
        "UPDATE users SET monthly_limit_micro_credits = 0 WHERE email = ?",
        [email],
      );
      expect((res as { affectedRows: number }).affectedRows).toBe(1);
    } finally {
      await conn.end();
    }

    const retry = await call(`quota-${id}`);
    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBe(true);
    expect(retry.body.taskId).toBe(first.body.taskId);

    // 新键是新请求:上限已满,拒绝受理
    const fresh = await call(`quota-new-${id}`);
    expect(fresh.status).toBe(402);
    expect(fresh.body.code).toBe("account_limit_exceeded");
  });
});
