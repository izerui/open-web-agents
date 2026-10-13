// 设计缺陷修复的端到端回归:从 HTTP 入口打进去,确认各条规则真的接在运行路径上。
//
// 与 access.e2e.ts 同一个理由:这些规则(限长、幂等、凭证覆盖、回调权限)
// 单独看都有单测,但"路由到底有没有调它"只有从外面打进来才测得出。

import { beforeAll, describe, expect, it } from "vitest";
import { Client, newUser, serverUp } from "./client";

type AgentRes = { agent?: { id: string; webhookUrl?: string }; error?: string };
type ListRes = {
  agents?: { id: string; webhookUrl?: string; canManageWebhook?: boolean }[];
};
type KeyRes = { plaintext?: string };
type InvokeRes = { taskId?: string; sessionId?: string; replayed?: boolean; error?: string };
type MeRes = { user?: { email: string; webhookSecretMask?: string | null } };

describe("对外 invoke 的入口规则", () => {
  let owner: Client;
  let agentId: string;
  let key: string;

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
    owner = await newUser("invoker");
    const a = await owner.post<AgentRes>("/api/agents", {
      name: `invoke-${Date.now()}`,
      config: { systemPrompt: "p", model: "sonnet" },
    });
    agentId = a.body.agent?.id ?? "";
    const k = await owner.post<KeyRes>("/api/keys", { name: "invoke-key", agentId });
    key = k.body.plaintext ?? "";
    expect(agentId && key).toBeTruthy();
  });

  const invoke = (body: unknown, headers: Record<string, string> = {}) =>
    new Client("anon").post<InvokeRes>(`/api/agents/${agentId}/invoke`, body, {
      "X-Api-Key": key,
      ...headers,
    });

  it("超长输入返回 413,而不是 INSERT 失败的 500", async () => {
    const r = await invoke({ input: "x".repeat(200_001) });
    expect(r.status).toBe(413);
  });

  it("超过旧 varchar(8192) 上限的输入可以正常受理", async () => {
    const r = await invoke({ input: "y".repeat(20_000) });
    expect(r.status).toBe(202);
  });

  it("同一个 Idempotency-Key 重复提交,拿回同一个任务", async () => {
    const idem = { "Idempotency-Key": `e2e-${Date.now()}` };
    const first = await invoke({ input: "幂等" }, idem);
    expect(first.status).toBe(202);
    const again = await invoke({ input: "幂等" }, idem);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(again.body.taskId).toBe(first.body.taskId);
  });

  it("并发的同键请求也只受理一次", async () => {
    const idem = { "Idempotency-Key": `e2e-race-${Date.now()}` };
    const rs = await Promise.all([1, 2, 3, 4].map(() => invoke({ input: "并发" }, idem)));
    expect(new Set(rs.map((r) => r.body.taskId)).size).toBe(1);
    expect(rs.filter((r) => r.status === 202)).toHaveLength(1);
  });

  it("非法的 Idempotency-Key 返回 400", async () => {
    const r = await invoke({ input: "x" }, { "Idempotency-Key": "k".repeat(129) });
    expect(r.status).toBe(400);
  });

  it("请求级覆盖做校验:非法 baseUrl / 未知模型别名返回 400", async () => {
    expect((await invoke({ input: "x", override: { baseUrl: "ftp://x" } })).status).toBe(400);
    expect((await invoke({ input: "x", override: { model: "gpt-9" } })).status).toBe(400);
  });

  it("合法的请求级覆盖被受理(会加密入库,随任务交给 worker)", async () => {
    const r = await invoke({ input: "x", override: { key: "sk-caller", model: "haiku" } });
    expect(r.status).toBe(202);
  });
});

describe("webhook 的权限与地址策略", () => {
  let owner: Client;
  let collaborator: Client;
  let agentId: string;

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
    owner = await newUser("hookowner");
    collaborator = await newUser("hookcollab");
    const a = await owner.post<AgentRes>("/api/agents", {
      name: `hook-${Date.now()}`,
      webhookUrl: "https://hooks.example.com/owa",
      config: { systemPrompt: "p", model: "sonnet" },
    });
    expect(a.status).toBe(201);
    agentId = a.body.agent?.id ?? "";
    const email = (await collaborator.get<MeRes>("/api/auth")).body.user?.email;
    const share = await owner.post(`/api/agents/${agentId}/share`, {
      target: email,
      permission: "write",
    });
    expect(share.status).toBeLessThan(300);
  });

  it("回调地址不能指向回环 / 云元数据", async () => {
    for (const url of ["http://127.0.0.1:9000/x", "http://169.254.169.254/latest/meta-data"]) {
      const r = await owner.post<AgentRes>("/api/agents", {
        id: agentId,
        name: "hook",
        webhookUrl: url,
        config: { systemPrompt: "p", model: "sonnet" },
      });
      expect(r.status).toBe(400);
    }
  });

  it("有 write 权限的协作者看不到回调地址", async () => {
    const list = await collaborator.get<ListRes>("/api/agents");
    const a = (list.body.agents ?? []).find((x) => x.id === agentId);
    expect(a).toBeTruthy();
    expect(a?.webhookUrl).toBeUndefined();
    expect(a?.canManageWebhook).toBe(false);
  });

  it("协作者改不了回调地址 —— 否则能把所有者的调用结果转发走", async () => {
    const r = await collaborator.post<AgentRes>("/api/agents", {
      id: agentId,
      name: "hook",
      webhookUrl: "https://attacker.example/steal",
      config: { systemPrompt: "p", model: "sonnet" },
    });
    expect(r.status).toBe(403);
  });

  it("协作者正常保存(不带回调字段)不会把所有者的回调清掉", async () => {
    const r = await collaborator.post<AgentRes>("/api/agents", {
      id: agentId,
      name: "hook-改名",
      config: { systemPrompt: "p2", model: "sonnet" },
    });
    expect(r.status).toBe(201);
    const list = await owner.get<ListRes>("/api/agents");
    const a = (list.body.agents ?? []).find((x) => x.id === agentId);
    expect(a?.webhookUrl).toBe("https://hooks.example.com/owa");
  });

  it("签名密钥:生成后明文只回一次,登录态里只有掩码", async () => {
    const gen = await owner.post<{ secret?: string }>("/api/me/webhook-secret", {});
    expect(gen.status).toBe(201);
    const secret = gen.body.secret ?? "";
    expect(secret.startsWith("whsec_")).toBe(true);
    const me = await owner.get<MeRes>("/api/auth");
    expect(me.body.user?.webhookSecretMask).toBeTruthy();
    expect(JSON.stringify(me.body)).not.toContain(secret);

    expect((await owner.post("/api/me/webhook-secret", { secret: "short" })).status).toBe(400);
    expect((await owner.del("/api/me/webhook-secret")).status).toBe(200);
    expect((await owner.get<MeRes>("/api/auth")).body.user?.webhookSecretMask).toBeNull();
  });
});
