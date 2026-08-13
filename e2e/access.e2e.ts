// 越权攻击面的端到端回归。
//
// 【为什么必须是端到端】这一组缺陷的共同点是:每一层单独看都合理,合起来才出事。
// 域逻辑的单测覆盖了 canInvokeAgent 的判定表,但覆盖不了"路由到底有没有调它"——
// 而真实的漏洞恰恰是【授权体系存在但运行路径没接上】。只有从 HTTP 打进去才测得出来。
//
// 这一整组曾经全是绿的,而攻击者用一个普通账号就能:
//   跑别人的私有智能体拿到 systemPrompt 与知识库正文 / 枚举并吊销全平台的 API Key。
// 它们此前只在我手工跑的 shell 脚本里验证过 —— 也就是说,下次谁改坏了没人会知道。

import { beforeAll, describe, expect, it } from "vitest";
import { Client, newUser, serverUp } from "./client";

type AgentRes = { agent?: { id: string }; error?: string };
type ListRes = { agents?: { id: string; name: string }[] };
type SessionRes = { session?: { id: string }; error?: string };
type KeyRes = { key?: { id: string }; plaintext?: string };
type KeysRes = { keys?: { id: string; name?: string }[] };
type GrantRes = { grant?: { id: string } };
type MeRes = { user?: { id: string; email: string } };

describe("越权攻击面", () => {
  let victim: Client;
  let attacker: Client;
  let attackerEmail: string;
  /** 受害者的私有智能体 —— 没有分享给任何人 */
  let secretId: string;

  beforeAll(async () => {
    if (!(await serverUp())) {
      throw new Error(
        "e2e 需要一个跑着的服务。先 `pnpm build && pnpm start`,或直接用 `pnpm test:e2e`(自动起停)。",
      );
    }
    victim = await newUser("victim");
    attacker = await newUser("attacker");
    attackerEmail = (await attacker.get<MeRes>("/api/auth")).body.user?.email ?? "";

    const created = await victim.post<AgentRes>("/api/agents", {
      name: `私有智能体-${Date.now()}`,
      config: { systemPrompt: "这是绝密提示词", model: "sonnet" },
    });
    expect(created.status).toBeLessThan(300);
    secretId = created.body.agent?.id ?? "";
    expect(secretId).toBeTruthy();
  });

  it("受害者自己能跑自己的智能体(对照组 —— 防止全靠拒绝拿满分)", async () => {
    const r = await victim.post<SessionRes>("/api/sessions", { agentId: secretId });
    expect(r.status).toBe(201);
  });

  it("攻击者仅凭 id 建不了会话 —— 私有智能体不可运行", async () => {
    const r = await attacker.post<SessionRes>("/api/sessions", { agentId: secretId });
    expect(r.status).toBe(403);
  });

  it("攻击者的智能体列表里看不到它", async () => {
    const r = await attacker.get<ListRes>("/api/agents");
    expect((r.body.agents ?? []).map((a) => a.id)).not.toContain(secretId);
  });

  it("攻击者不能签一把绑定到受害者智能体的 key", async () => {
    const r = await attacker.post<KeyRes>("/api/keys", { name: "steal", agentId: secretId });
    // 与"智能体不存在"同码:这个接口不能变成 id 存在性预言机
    expect(r.status).toBe(404);
  });

  it("攻击者不能改受害者的智能体定义", async () => {
    const r = await attacker.post<AgentRes>("/api/agents", {
      id: secretId,
      name: "被篡改",
      config: { systemPrompt: "hacked", model: "sonnet" },
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it("攻击者读不到受害者智能体的知识库", async () => {
    const r = await attacker.get(`/api/agents/${secretId}/knowledge`);
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it("攻击者不能把受害者的智能体分享给自己", async () => {
    const r = await attacker.post(`/api/agents/${secretId}/share`, {
      target: attackerEmail,
      permission: "write",
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
});

describe("API Key 归属隔离", () => {
  let a: Client;
  let b: Client;
  let aKeyId: string;

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
    a = await newUser("keyowner");
    b = await newUser("keythief");
    const r = await a.post<KeyRes>("/api/keys", { name: "A 的 key" });
    expect(r.status).toBe(201);
    aKeyId = r.body.key?.id ?? "";
    expect(aKeyId).toBeTruthy();
    // 明文只在签发时返回一次
    expect(r.body.plaintext).toBeTruthy();
  });

  it("各自只看得到自己的 key —— 曾经这里能枚举全平台", async () => {
    await b.post("/api/keys", { name: "B 的 key" });
    const listB = await b.get<KeysRes>("/api/keys");
    expect((listB.body.keys ?? []).map((k) => k.id)).not.toContain(aKeyId);
    expect((listB.body.keys ?? []).every((k) => k.name === "B 的 key")).toBe(true);
  });

  it("吊销别人的 key 返回 404,且那把 key 完好", async () => {
    const del = await b.del(`/api/keys?id=${aKeyId}`);
    expect(del.status).toBe(404);

    const listA = await a.get<KeysRes>("/api/keys");
    expect((listA.body.keys ?? []).map((k) => k.id)).toContain(aKeyId);
  });

  it("吊销自己的 key 正常", async () => {
    const own = await a.post<KeyRes>("/api/keys", { name: "临时" });
    const id = own.body.key?.id ?? "";
    expect((await a.del(`/api/keys?id=${id}`)).status).toBe(200);
    const after = await a.get<KeysRes>("/api/keys");
    expect((after.body.keys ?? []).map((k) => k.id)).not.toContain(id);
  });

  it("列表与详情都不回明文密钥", async () => {
    const list = await a.get("/api/keys");
    expect(JSON.stringify(list.body)).not.toMatch(/owa_sk|plaintext/);
  });
});

describe("分享闭环:授予后可用,撤销后立刻失效", () => {
  let owner: Client;
  let mate: Client;
  let agentId: string;
  let grantId: string;

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
    owner = await newUser("owner");
    mate = await newUser("mate");
    const created = await owner.post<AgentRes>("/api/agents", {
      name: `分享测试-${Date.now()}`,
      config: { systemPrompt: "p", model: "sonnet" },
    });
    agentId = created.body.agent?.id ?? "";
  });

  it("撤销之前:分享 → 对方可运行", async () => {
    const email = (await mate.get<MeRes>("/api/auth")).body.user?.email ?? "";
    const g = await owner.post<GrantRes>(`/api/agents/${agentId}/share`, {
      target: email,
      permission: "read",
    });
    expect(g.status).toBe(201);
    grantId = g.body.grant?.id ?? "";

    const s = await mate.post<SessionRes>("/api/sessions", { agentId });
    expect(s.status).toBe(201);
  });

  it("撤销之后:立刻不可运行 —— 不能只是从列表里隐藏", async () => {
    const r = await owner.del(`/api/agents/${agentId}/share?grantId=${grantId}`);
    expect(r.status).toBeLessThan(300);

    const s = await mate.post<SessionRes>("/api/sessions", { agentId });
    expect(s.status).toBe(403);
  });
});

describe("未登录一律拒绝", () => {
  const anon = () => new Client("anon");

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
  });

  for (const [method, path] of [
    ["GET", "/api/agents"],
    ["GET", "/api/sessions"],
    ["GET", "/api/keys"],
    ["GET", "/api/usage"],
    ["GET", "/api/groups"],
  ] as const) {
    it(`${method} ${path} → 401`, async () => {
      const r = await anon().req(method, path);
      expect(r.status).toBe(401);
    });
  }

  it("伪造的 API Key 被拒", async () => {
    const r = await anon().get("/api/agents", { "X-Api-Key": "owa_sk_deadbeefdeadbeef" });
    expect(r.status).toBe(401);
  });
});
