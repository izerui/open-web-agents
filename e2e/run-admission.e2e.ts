// 统一受理关卡的端到端回归:API 会话的输入契约、Key 限流对 API 会话同样生效。
// 只断言"过没过受理":用流式响应,拿到响应头即取消运行,不等模型跑完(服务可能接着真实模型)。

import { beforeAll, describe, expect, it } from "vitest";
import { BASE, Client, newUser, serverUp } from "./client";

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
  const TERMINAL = ["success", "failed", "cancelled"];

  /** 读 SSE 直到"已入队"或运行已出结果。响应头先于入队发出,只看头不能保证库里已有这条运行。 */
  const waitQueued = async (res: Response): Promise<"queued" | "finished"> => {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error("事件流在入队前结束");
        buf += decoder.decode(value, { stream: true });
        let cut = buf.indexOf("\n\n");
        while (cut >= 0) {
          const data = buf
            .slice(0, cut)
            .split("\n")
            .find((l) => l.startsWith("data: "));
          buf = buf.slice(cut + 2);
          cut = buf.indexOf("\n\n");
          if (!data) continue;
          const e = JSON.parse(data.slice(6)) as { kind?: string; label?: string };
          if (e.kind === "result") return "finished";
          if (e.kind === "status" && e.label === "已入队") return "queued";
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  };

  /** 发起一轮:被拒时返回错误体;受理后等入队、取消运行,并确认它已停下。 */
  const startRun = async (auth: Record<string, string>, sessionId: string, body: object) => {
    const res = await fetch(`${BASE}/api/sessions/${sessionId}/run`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ stream: true, ...body }),
    });
    if (res.status !== 200) {
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Err };
    }
    const runId = res.headers.get("X-Run-Id");
    expect(runId).toBeTruthy();
    await waitQueued(res);
    const cancel = await fetch(`${BASE}/api/runs/${runId}/cancel`, {
      method: "POST",
      headers: auth,
    });
    expect(cancel.status).toBe(200);
    const c = (await cancel.json()) as { cancelled?: boolean; status?: string };
    expect(c.cancelled === true || TERMINAL.includes(c.status ?? "")).toBe(true);
    return { status: res.status, body: {} as Err };
  };

  it("API 会话 + inputSchema:纯文本与不合格输入 400,合格输入通过受理(与 invoke 同一份契约)", async () => {
    const agentId = await mkAgent("adm-schema", SCHEMA);
    const key = await mkKey(agentId);
    const s = await apiSession(key, agentId);
    expect(s?.source).toBe("api");
    const run = (body: object) => startRun({ "X-Api-Key": key }, s?.id ?? "", body);

    const text = await run({ prompt: "随便聊聊" });
    expect(text.status).toBe(400);
    expect(text.body.code).toBe("input_invalid");
    const bad = await run({ input: { nope: 1 } });
    expect(bad.status).toBe(400);
    expect(bad.body.details).toBeTruthy();
    const ok = await run({ input: { topic: "基本不等式" } });
    expect(ok.status).toBe(200);
  });

  it("Key 限流对 API 会话同样生效:每分钟 1 次,第二次 429(scope=key)", async () => {
    const agentId = await mkAgent("adm-rate");
    const key = await mkKey(agentId, 1);
    const s = await apiSession(key, agentId);
    const run = () => startRun({ "X-Api-Key": key }, s?.id ?? "", { prompt: "你好" });
    expect((await run()).status).toBe(200);
    const second = await run();
    expect(second.status).toBe(429);
    expect(second.body).toMatchObject({ code: "rate_limited", scope: "key" });
  });

  it("网页对话不受接口契约约束:同一个声明了 inputSchema 的智能体,自然语言照常受理", async () => {
    const agentId = await mkAgent("adm-web", SCHEMA);
    const s = (await owner.post<{ session?: { id: string } }>("/api/sessions", { agentId })).body
      .session;
    const r = await startRun({ Cookie: owner.cookieHeader() }, s?.id ?? "", { prompt: "随便聊聊" });
    expect(r.status).toBe(200);
  });
});
