// 统一受理关卡的端到端回归:API 会话的输入契约、Key 限流对 API 会话与嵌入组件同样生效。
// e2e 屏蔽了模型调用,受理后的运行会很快以失败收尾 —— 这里只断言"过没过受理"。

import { beforeAll, describe, expect, it } from "vitest";
import { Client, newUser, serverUp } from "./client";

type AgentRes = { agent?: { id: string } };
type KeyRes = { plaintext?: string };
type Err = { code?: string; scope?: string; details?: unknown };

const SCHEMA = {
  type: "object",
  required: ["topic"],
  properties: { topic: { type: "string" } },
  additionalProperties: false,
};

describe("统一受理关卡", () => {
  let owner: Client;
  const anon = new Client("anon-adm");

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
    owner = await newUser("admission");
  });

  const mkAgent = async (name: string, inputSchema?: unknown) =>
    (
      await owner.post<AgentRes>("/api/agents", {
        name: `${name}-${Date.now()}`,
        config: { systemPrompt: "p", model: "sonnet", inputSchema },
      })
    ).body.agent?.id ?? "";
  const mkKey = async (agentId: string, rateLimitPerMinute?: number) =>
    (await owner.post<KeyRes>("/api/keys", { name: "adm", agentId, rateLimitPerMinute })).body
      .plaintext ?? "";
  const apiSession = async (key: string, agentId: string) =>
    (
      await anon.post<{ session?: { id: string; source?: string } }>(
        "/api/sessions",
        { agentId },
        { "X-Api-Key": key },
      )
    ).body.session;

  it("API 会话 + inputSchema:纯文本与不合格输入 400,合格输入通过受理(与 invoke 同一份契约)", async () => {
    const agentId = await mkAgent("adm-schema", SCHEMA);
    const key = await mkKey(agentId);
    const s = await apiSession(key, agentId);
    expect(s?.source).toBe("api");
    const run = (body: unknown) =>
      anon.post<Err>(
        `/api/sessions/${s?.id}/run`,
        { stream: false, ...(body as object) },
        {
          "X-Api-Key": key,
        },
      );

    const text = await run({ prompt: "随便聊聊" });
    expect(text.status).toBe(400);
    expect(text.body.code).toBe("input_invalid");
    const bad = await run({ input: { nope: 1 } });
    expect(bad.status).toBe(400);
    expect(bad.body.details).toBeTruthy();
    const ok = await run({ input: { topic: "基本不等式" } });
    expect([400, 402, 413, 429]).not.toContain(ok.status);
  });

  it("Key 限流对 API 会话同样生效:每分钟 1 次,第二次 429(scope=key)", async () => {
    const agentId = await mkAgent("adm-rate");
    const key = await mkKey(agentId, 1);
    const s = await apiSession(key, agentId);
    const run = () =>
      anon.post<Err>(
        `/api/sessions/${s?.id}/run`,
        { prompt: "你好", stream: false },
        {
          "X-Api-Key": key,
        },
      );
    expect((await run()).status).not.toBe(429);
    const second = await run();
    expect(second.status).toBe(429);
    expect(second.body).toMatchObject({ code: "rate_limited", scope: "key" });
  });

  it("Key 限流对嵌入组件同样生效:访客的运行记在签发 Key 上", async () => {
    const agentId = await mkAgent("adm-embed");
    const key = await mkKey(agentId, 1);
    const token =
      (await anon.post<{ token?: string }>("/api/embed/token", { agentId }, { "X-Api-Key": key }))
        .body.token ?? "";
    const run = () =>
      anon.post<Err>("/api/embed/run", { prompt: "你好" }, { "X-Embed-Token": token });
    expect((await run()).status).not.toBe(429);
    const second = await run();
    expect(second.status).toBe(429);
    expect(second.body.code).toBe("rate_limited");
  });

  it("网页对话不受接口契约约束:同一个声明了 inputSchema 的智能体,自然语言照常受理", async () => {
    const agentId = await mkAgent("adm-web", SCHEMA);
    const s = (await owner.post<{ session?: { id: string } }>("/api/sessions", { agentId })).body
      .session;
    const r = await owner.post(`/api/sessions/${s?.id}/run`, { prompt: "随便聊聊", stream: false });
    expect([400, 429]).not.toContain(r.status);
  });
});
