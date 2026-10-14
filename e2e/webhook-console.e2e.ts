// 回调投递记录、测试投递、手动重发的端到端回归。
// e2e 起不了可达的回调接收端(回环地址始终被策略拦截),测试投递指向一个永不可解析的
// .invalid 域名:验证"失败如实记录、地址脱敏、权限"。成功路径由单测(假发送器)覆盖。

import { beforeAll, describe, expect, it } from "vitest";
import { Client, newUser, serverUp } from "./client";

type AgentRes = { agent?: { id: string } };
type Delivery = { trigger: string; ok: boolean; url: string; error?: string; runId?: string };

const HOOK = "https://hook.owa-e2e.invalid/in?token=TOPSECRET-77";

describe("回调投递记录与操作", () => {
  let owner: Client;
  let reader: Client;
  let stranger: Client;
  let agentId = "";
  let plainAgentId = "";
  let key = "";
  const anon = new Client("anon-wh");

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
    owner = await newUser("wh-owner");
    reader = await newUser("wh-reader");
    stranger = await newUser("wh-stranger");
    agentId =
      (
        await owner.post<AgentRes>("/api/agents", {
          name: `wh-${Date.now()}`,
          webhookUrl: HOOK,
          config: { systemPrompt: "p", model: "sonnet" },
        })
      ).body.agent?.id ?? "";
    plainAgentId =
      (
        await owner.post<AgentRes>("/api/agents", {
          name: `wh-plain-${Date.now()}`,
          config: { systemPrompt: "p", model: "sonnet" },
        })
      ).body.agent?.id ?? "";
    const readerEmail = (await reader.get<{ user?: { email: string } }>("/api/auth")).body.user
      ?.email;
    await owner.post(`/api/agents/${agentId}/share`, { target: readerEmail, permission: "read" });
    key =
      (await owner.post<{ plaintext?: string }>("/api/keys", { name: "wh" })).body.plaintext ?? "";
  });

  it("测试投递:接口 200,失败如实记录;记录里的地址去掉了查询串与令牌", async () => {
    const r = await owner.post<{ delivery?: Delivery }>(`/api/agents/${agentId}/webhook/test`, {});
    expect(r.status).toBe(200);
    expect(r.body.delivery).toMatchObject({ trigger: "test", ok: false });
    expect(r.body.delivery?.error).toBeTruthy();

    const list = await owner.get<{ items?: Delivery[] }>(
      `/api/agents/${agentId}/webhook/deliveries`,
    );
    expect(list.status).toBe(200);
    expect(list.body.items?.[0]).toMatchObject({
      trigger: "test",
      url: "https://hook.owa-e2e.invalid/in",
    });
    expect(JSON.stringify(list.body)).not.toContain("TOPSECRET");
  });

  it("没配回调地址:测试投递 409", async () => {
    expect((await owner.post(`/api/agents/${plainAgentId}/webhook/test`, {})).status).toBe(409);
  });

  it("权限:只读协作者 403,无关的人 404,API Key 拿不到", async () => {
    expect((await reader.get(`/api/agents/${agentId}/webhook/deliveries`)).status).toBe(403);
    expect((await reader.post(`/api/agents/${agentId}/webhook/test`, {})).status).toBe(403);
    expect((await stranger.get(`/api/agents/${agentId}/webhook/deliveries`)).status).toBe(404);
    const byKey = await anon.get(`/api/agents/${agentId}/webhook/deliveries`, { "X-Api-Key": key });
    expect([401, 403]).toContain(byKey.status);
  });

  it(
    "手动重发:接口调用的运行结束后可放回发件箱;投递中再点 409;网页对话的运行 409;别人 404",
    { timeout: 60_000 },
    async () => {
      // 没配回调的智能体:运行结束后发件箱很快把它标为 skipped,便于确定性地重发
      const invoke = await anon.post<{ taskId?: string }>(
        `/api/agents/${plainAgentId}/invoke`,
        { input: "触发一次运行" },
        { "X-Api-Key": key },
      );
      const taskId = invoke.body.taskId ?? "";
      expect(taskId).toBeTruthy();

      let status = 0;
      for (let i = 0; i < 60 && status !== 202; i++) {
        status = (await owner.post(`/api/runs/${taskId}/webhook/redeliver`, {})).status;
        if (status !== 202) await new Promise((r) => setTimeout(r, 500));
      }
      expect(status).toBe(202);
      // 刚放回去,还在待投:不重复入队
      expect((await owner.post(`/api/runs/${taskId}/webhook/redeliver`, {})).status).toBe(409);
      expect((await stranger.post(`/api/runs/${taskId}/webhook/redeliver`, {})).status).toBe(404);

      const s = (
        await owner.post<{ session?: { id: string } }>("/api/sessions", { agentId: plainAgentId })
      ).body.session;
      const run = await owner.post<{ runId?: string }>(`/api/sessions/${s?.id}/run`, {
        prompt: "网页对话",
        stream: false,
      });
      const runId = run.body.runId ?? run.headers.get("x-run-id") ?? "";
      expect(runId).toBeTruthy();
      const web = await owner.post<{ error?: string }>(`/api/runs/${runId}/webhook/redeliver`, {});
      expect(web.status).toBe(409);
      // 只看状态码分不清:网页运行的发件箱可能还在待投,"正在投递中"同样是 409
      expect(web.body.error).toMatch(/只有接口调用与 API 会话/);
    },
  );

  it("测试与重发都进审计", async () => {
    const a = await owner.get<{ items?: { action: string }[] }>("/api/audit?limit=200");
    const actions = (a.body.items ?? []).map((e) => e.action);
    expect(actions).toContain("webhook.test");
    expect(actions).toContain("webhook.redeliver");
  });
});
