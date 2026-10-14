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

  it("同一个 Idempotency-Key 配不同请求体:422 idempotency_conflict", async () => {
    const idem = { "Idempotency-Key": `e2e-conflict-${Date.now()}` };
    expect((await invoke({ input: "内容A" }, idem)).status).toBe(202);
    const r = await invoke({ input: "内容B" }, idem);
    expect(r.status).toBe(422);
    expect((r.body as { code?: string }).code).toBe("idempotency_conflict");
  });

  it("错误响应带机读的 code", async () => {
    const r = await invoke({ input: "x".repeat(200_001) });
    expect((r.body as { code?: string }).code).toBe("prompt_too_large");
    const noKey = await new Client("anon").post<{ code?: string }>(
      `/api/agents/${agentId}/invoke`,
      {
        input: "x",
      },
    );
    expect(noKey.status).toBe(401);
    expect(noKey.body.code).toBe("unauthorized");
  });

  it("结果接口先鉴权:未带 key 时,存在与不存在的任务都回 401(不能用来探测任务 id)", async () => {
    const real = await invoke({ input: "probe" });
    const anon = new Client("anon");
    expect((await anon.get(`/api/agents/${real.body.taskId}/result`)).status).toBe(401);
    expect((await anon.get("/api/agents/no-such-task/result")).status).toBe(401);
  });

  it("非法的 Idempotency-Key 返回 400", async () => {
    const r = await invoke({ input: "x" }, { "Idempotency-Key": "k".repeat(129) });
    expect(r.status).toBe(400);
  });

  it("请求级覆盖做校验:非法 baseUrl / 未知模型别名返回 400", async () => {
    expect((await invoke({ input: "x", override: { baseUrl: "ftp://x" } })).status).toBe(400);
    expect((await invoke({ input: "x", override: { model: "gpt-9" } })).status).toBe(400);
  });

  it.each([
    { baseUrl: "https://attacker.example" },
    { key: "sk-caller" },
    { key: "sk-caller", model: "haiku" },
    { baseUrl: "https://attacker.example", key: "sk-caller" },
    { baseUrl: "", key: "" },
  ])("平台凭证不允许被请求覆盖: %j", async (override) => {
    const r = await invoke({ input: "x", override });
    expect(r.status).toBe(400);
  });

  it("仅选择平台模型别名的请求被受理", async () => {
    const r = await invoke({ input: "x", override: { model: "haiku" } });
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

describe("安全边界", () => {
  let user: Client;

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
    user = await newUser("boundary");
  });

  it("普通用户不能设置逃生舱", async () => {
    const r = await user.post<AgentRes>("/api/agents", {
      name: `hatch-${Date.now()}`,
      config: { systemPrompt: "p", model: "sonnet", escapeHatch: { maxBudgetUsd: 1 } },
    });
    expect(r.status).toBe(403);
  });

  it("逃生舱里的安全边界字段在保存时就被拒绝", async () => {
    const r = await user.post<AgentRes>("/api/agents", {
      name: `hatch2-${Date.now()}`,
      config: { systemPrompt: "p", model: "sonnet", escapeHatch: { hooks: {}, cwd: "/" } },
    });
    expect(r.status).toBe(400);
  });

  it("权限模式能保存并读回(曾被静默丢弃)", async () => {
    const created = await user.post<AgentRes>("/api/agents", {
      name: `perm-${Date.now()}`,
      config: { systemPrompt: "p", model: "sonnet", permissionMode: "acceptEdits" },
    });
    expect(created.status).toBe(201);
    const list = await user.get<{ agents?: { id: string; config: { permissionMode?: string } }[] }>(
      "/api/agents",
    );
    const a = (list.body.agents ?? []).find((x) => x.id === created.body.agent?.id);
    expect(a?.config.permissionMode).toBe("acceptEdits");
  });

  it.each([
    { baseUrl: "https://attacker.example" },
    { apiKey: "sk-retired-byok" },
    { baseUrl: "https://attacker.example", apiKey: "sk-retired-byok" },
    { baseUrl: "", apiKey: "" },
  ])("旧账号模型凭证设置已停用: %j", async (body) => {
    const r = await user.put<{ code: string }>("/api/me/credentials", body);
    expect(r.status).toBe(410);
    expect(r.body.code).toBe("byok_disabled");
    const me = await user.get<{ user: Record<string, unknown> }>("/api/auth");
    expect(me.status).toBe(200);
    expect(me.body.user).not.toHaveProperty("defaultBaseUrl");
    expect(me.body.user).not.toHaveProperty("anthropicKeyMask");
    expect(JSON.stringify(me.body)).not.toContain("sk-retired-byok");
  });

  it("旧凭证接口仍要求登录", async () => {
    const r = await new Client("anonymous").put("/api/me/credentials", {
      apiKey: "sk-retired-byok",
    });
    expect(r.status).toBe(401);
  });
});

describe("会话管理与接口调用可见性", () => {
  type Sess = { id: string; title?: string; source?: string };
  let user: Client;
  let other: Client;
  let agentId: string;

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
    user = await newUser("sessmgr");
    other = await newUser("sessother");
    const a = await user.post<AgentRes>("/api/agents", {
      name: `sess-${Date.now()}`,
      config: { systemPrompt: "p", model: "sonnet" },
    });
    agentId = a.body.agent?.id ?? "";
  });

  const mine = async () =>
    (await user.get<{ sessions?: Sess[] }>("/api/sessions")).body.sessions ?? [];

  it("重命名、归档、删除;删除后读不到也跑不了", async () => {
    const created = await user.post<{ session?: Sess }>("/api/sessions", { agentId });
    const id = created.body.session?.id ?? "";
    expect(created.body.session?.source).toBe("web");

    expect(
      (await user.req("PATCH", `/api/sessions/${id}`, { body: { title: "新标题" } })).status,
    ).toBe(200);
    expect((await mine()).find((s) => s.id === id)?.title).toBe("新标题");

    // 别人改不了
    expect((await other.req("PATCH", `/api/sessions/${id}`, { body: { title: "x" } })).status).toBe(
      403,
    );

    expect(
      (await user.req("PATCH", `/api/sessions/${id}`, { body: { archived: true } })).status,
    ).toBe(200);
    expect((await mine()).some((s) => s.id === id)).toBe(false);
    expect(
      (await user.req("PATCH", `/api/sessions/${id}`, { body: { archived: false } })).status,
    ).toBe(200);
    expect((await mine()).some((s) => s.id === id)).toBe(true);

    expect((await user.del(`/api/sessions/${id}`)).status).toBe(200);
    expect((await mine()).some((s) => s.id === id)).toBe(false);
    expect((await user.get(`/api/sessions/${id}/files`)).status).toBe(403);
    expect(
      (await user.post(`/api/sessions/${id}/run`, { prompt: "hi", stream: false })).status,
    ).toBe(403);
  });

  it("用自己的 key 发起的接口调用:签发人能在 integrations 视图看到并读取,别人不能", async () => {
    const k = await user.post<KeyRes>("/api/keys", { name: "vis", agentId });
    const inv = await new Client("anon").post<InvokeRes>(
      `/api/agents/${agentId}/invoke`,
      { input: "x" },
      { "X-Api-Key": k.body.plaintext ?? "" },
    );
    const sid = inv.body.sessionId ?? "";
    expect(sid).toBeTruthy();

    // 工作台默认列表不混入接口调用
    expect((await mine()).some((s) => s.id === sid)).toBe(false);
    const integ =
      (await user.get<{ sessions?: Sess[] }>("/api/sessions?view=integrations")).body.sessions ??
      [];
    expect(integ.find((s) => s.id === sid)?.source).toBe("invoke");

    expect((await user.get(`/api/sessions/${sid}/history`)).status).toBeLessThan(400);
    expect((await other.get(`/api/sessions/${sid}/history`)).status).toBe(403);
  });
});

describe("账号安全", () => {
  it("改密码:旧密码错拒绝,改完能用新密码登录", async () => {
    const c = new Client("pw");
    const email = `e2e-pw-${Date.now()}@example.test`;
    await c.post("/api/auth", { action: "register", email, password: "old-password-1" });
    expect(
      (await c.put("/api/me/password", { current: "wrong-pass", next: "new-password-2" })).status,
    ).toBe(400);
    expect(
      (await c.put("/api/me/password", { current: "old-password-1", next: "new-password-2" }))
        .status,
    ).toBe(200);
    const fresh = new Client("pw2");
    expect(
      (await fresh.post("/api/auth", { action: "login", email, password: "new-password-2" }))
        .status,
    ).toBe(200);
  });

  it("同一账号连续输错密码会被限流", async () => {
    const email = `e2e-rl-${Date.now()}@example.test`;
    const c = new Client("rl");
    await c.post("/api/auth", { action: "register", email, password: "right-password" });
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push(
        (await new Client("x").post("/api/auth", { action: "login", email, password: "nope-nope" }))
          .status,
      );
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe("运行记录", () => {
  type RunList = { items?: { id: string; source: string; status: string }[]; nextCursor?: string };
  let owner: Client;
  let other: Client;
  let key = "";
  let taskId = "";

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
    owner = await newUser("runs-owner");
    other = await newUser("runs-other");
    const a = await owner.post<AgentRes>("/api/agents", {
      name: `runs-${Date.now()}`,
      config: { systemPrompt: "p", model: "sonnet" },
    });
    const agentId = a.body.agent?.id ?? "";
    key = (await owner.post<KeyRes>("/api/keys", { name: "runs", agentId })).body.plaintext ?? "";
    const inv = await new Client("anon").post<InvokeRes>(
      `/api/agents/${agentId}/invoke`,
      { input: "列出运行" },
      { "X-Api-Key": key },
    );
    taskId = inv.body.taskId ?? "";
  });

  it("签发人在运行记录里看得到自己 Key 发起的调用;API Key 也能列出自己的", async () => {
    const mine = await owner.get<RunList>("/api/runs?source=invoke");
    expect((mine.body.items ?? []).map((r) => r.id)).toContain(taskId);
    const byKey = await new Client("anon").get<RunList>("/api/runs", { "X-Api-Key": key });
    expect((byKey.body.items ?? []).map((r) => r.id)).toContain(taskId);
  });

  it("详情:自己能看,别人 404", async () => {
    expect((await owner.get(`/api/runs/${taskId}`)).status).toBe(200);
    expect((await other.get(`/api/runs/${taskId}`)).status).toBe(404);
    expect((await other.get<RunList>("/api/runs")).body.items?.some((r) => r.id === taskId)).toBe(
      false,
    );
  });

  it("按 taskId 取消:别人不能取消;自己可以(已结束的如实说明)", async () => {
    expect((await other.post(`/api/runs/${taskId}/cancel`, {})).status).toBe(404);
    const r = await new Client("anon").post<{ cancelled?: boolean }>(
      `/api/runs/${taskId}/cancel`,
      {},
      { "X-Api-Key": key },
    );
    expect(r.status).toBe(200);
    expect(typeof r.body.cancelled).toBe("boolean");
  });

  it("非法筛选参数返回 400", async () => {
    expect((await owner.get("/api/runs?status=bogus")).status).toBe(400);
  });
});

describe("接入中心:按智能体的 OpenAPI 文档", () => {
  type Doc = { openapi?: string; paths?: Record<string, unknown>; servers?: { url: string }[] };
  let owner: Client;
  let other: Client;
  let agentId = "";
  let key = "";

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
    owner = await newUser("oas-owner");
    other = await newUser("oas-other");
    const a = await owner.post<AgentRes>("/api/agents", {
      name: `oas-${Date.now()}`,
      config: {
        systemPrompt: "p",
        model: "sonnet",
        inputSchema: { type: "object", properties: { topic: { type: "string" } } },
        outputSchema: { type: "object", properties: { url: { type: "string" } } },
      },
    });
    agentId = a.body.agent?.id ?? "";
    key = (await owner.post<KeyRes>("/api/keys", { name: "oas", agentId })).body.plaintext ?? "";
  });

  it("所有者(登录态)与该智能体的 Key 都能取到,契约嵌在文档里", async () => {
    const web = await owner.get<Doc>(`/api/agents/${agentId}/openapi.json`);
    expect(web.status).toBe(200);
    expect(web.body.openapi).toBe("3.1.0");
    expect(JSON.stringify(web.body.paths)).toContain('"topic"');
    const byKey = await new Client("anon").get<Doc>(`/api/agents/${agentId}/openapi.json`, {
      "X-Api-Key": key,
    });
    expect(byKey.status).toBe(200);
  });

  it("未登录 401;无权调用的人拿不到", async () => {
    expect((await new Client("anon").get(`/api/agents/${agentId}/openapi.json`)).status).toBe(401);
    expect([403, 404]).toContain((await other.get(`/api/agents/${agentId}/openapi.json`)).status);
  });
});

describe("知识库容量:列表带用量与可检索标记,超限明确拒绝", () => {
  type Listing = {
    docs?: { id: string; chars: number; searchable: boolean }[];
    usage?: { docs: number; chars: number };
    limits?: { maxDocs: number; maxDocChars: number; maxTotalChars: number };
  };

  it("新增后列表给出字数、用量与上限;单篇超长返回 409 limit_exceeded", async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
    const owner = await newUser("kb-cap");
    const agentId =
      (
        await owner.post<AgentRes>("/api/agents", {
          name: `kb-${Date.now()}`,
          config: { systemPrompt: "p", model: "sonnet" },
        })
      ).body.agent?.id ?? "";
    expect(
      (
        await owner.post(`/api/agents/${agentId}/knowledge`, {
          title: "制度",
          content: "报销上限五千",
        })
      ).status,
    ).toBe(201);

    const l = await owner.get<Listing>(`/api/agents/${agentId}/knowledge`);
    expect(l.body.usage).toEqual({ docs: 1, chars: 6 });
    expect(l.body.limits?.maxDocs).toBe(500);
    expect(l.body.docs?.[0]).toMatchObject({ chars: 6, searchable: true });

    const max = l.body.limits?.maxDocChars ?? 200_000;
    const tooLong = await owner.post<{ code?: string }>(`/api/agents/${agentId}/knowledge`, {
      title: "超长",
      content: "字".repeat(max + 1),
    });
    expect(tooLong.status).toBe(409);
    expect(tooLong.body.code).toBe("limit_exceeded");
    expect((await owner.get<Listing>(`/api/agents/${agentId}/knowledge`)).body.usage?.docs).toBe(1);
  });
});
