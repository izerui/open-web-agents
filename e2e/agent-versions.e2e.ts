// 智能体版本与发布的端到端回归。
//
// 核心承诺:草稿怎么改都不影响对外调用方;发布后调用方拿到新版,回滚秒级生效;
// 入参校验、结果、运行记录都对得上实际执行的那一版。这些都只有从 HTTP 入口打进来才测得出。

import { beforeAll, describe, expect, it } from "vitest";
import { Client, newUser, serverUp } from "./client";

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

  it("发布 v1;草稿没改时再发布返回 409 nothing_to_publish", async () => {
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
