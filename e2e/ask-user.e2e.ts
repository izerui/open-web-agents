// 提问在同一轮里等人回答(端到端):假网关按剧本让模型调用 AskUserQuestion,真实服务里跑 SDK、
// worker、审批通道。验证:网页对话里运行停在提问上、前端能拉到待回答,提交回答后模型在【同一轮】
// 收到 "The user answered";选择不回答,模型收到拒绝说明;接口调用没人可问,不等。
// 需要可写的测试库(OWA_E2E_DATABASE_URL):要临时把账号设为管理员来配假网关的提供者与模型。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeGateway } from "../scripts/sdk-probe/fake-gateway.mjs";
import { BASE, Client, newUser, serverUp } from "./client";

const databaseUrl = process.env.OWA_E2E_DATABASE_URL;
const C = 1_000_000n;

const ask = (id: string) => ({
  tool: {
    id,
    name: "AskUserQuestion",
    input: {
      questions: [
        {
          question: "报告用哪种格式?",
          header: "格式",
          multiSelect: false,
          options: [
            { label: "PDF", description: "便于打印" },
            { label: "Word", description: "便于修改" },
          ],
        },
      ],
    },
  },
});

type Pending = { id: string; toolUseId?: string; questions?: { question: string }[] };

describe.skipIf(!databaseUrl)("提问在同一轮里等人回答", () => {
  let gw: Awaited<ReturnType<typeof startFakeGateway>>;
  let admin: Client;
  let promotedId: string | undefined;
  let user: Client;
  let agentId = "";
  const tag = Date.now();

  async function db() {
    const { createConnection } = await import("mysql2/promise");
    return createConnection(databaseUrl as string);
  }

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("server unavailable");
    gw = await startFakeGateway([
      ask("toolu_answer"),
      { text: "好的,按你选的做。" },
      ask("toolu_decline"),
      { text: "那我自己决定。" },
      ask("toolu_api"),
      { text: "没人回答,我按 PDF 做。" },
      ask("toolu_apisession"),
      { text: "API 会话没人回答,我按 PDF 做。" },
    ]);
    admin = await newUser("ask-admin");
    const me = await admin.get<{ user: { id: string; role: string } }>("/api/auth");
    if (me.body.user.role !== "admin") {
      promotedId = me.body.user.id;
      const c = await db();
      await c.execute("UPDATE users SET role = 'admin' WHERE id = ?", [promotedId]);
      await c.end();
    }
    const p = await admin.post<{ provider: { id: string } }>("/api/admin/providers", {
      definition: {
        name: `提问测试-${tag}`,
        enabled: true,
        endpoints: { llm: { protocol: "anthropic", baseUrl: gw.baseUrl } },
      },
      apiKey: `sk-e2e-ask-${tag}`,
    });
    expect(p.status).toBe(201);
    const m = await admin.post<{ model: { id: string } }>("/api/admin/models", {
      expectedVersion: null,
      definition: {
        name: `提问模型-${tag}`,
        kind: "llm",
        modelId: `e2e-ask-${tag}`,
        enabled: true,
        acceptsImages: false,
        providerId: p.body.provider.id,
        markupBp: 0,
        reserveMicroCredits: (50n * C).toString(),
        costRates: [
          { meter: "input_token", units: "1000000", microCredits: "100000000" },
          { meter: "output_token", units: "1000000", microCredits: "100000000" },
          { meter: "cache_read_token", units: "1000000", microCredits: "10000000" },
          { meter: "cache_write_token", units: "1000000", microCredits: "100000000" },
        ],
        rates: [],
      },
    });
    expect(m.status, JSON.stringify(m.body)).toBe(201);
    user = await newUser("ask-user");
    const a = await user.post<{ agent: { id: string } }>("/api/agents", {
      name: `提问-${tag}`,
      config: { systemPrompt: "需要时先问用户", model: m.body.model.id, maxTurns: 4 },
    });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    agentId = a.body.agent.id;
  });

  afterAll(async () => {
    gw?.close();
    if (promotedId) {
      const c = await db();
      await c.execute("UPDATE users SET role = 'user' WHERE id = ?", [promotedId]);
      await c.end();
    }
  });

  /** 发起一次网页对话(流式,不等结束),返回会话 id 与读完流的 promise */
  async function startChat() {
    const s = await user.post<{ session: { id: string } }>("/api/sessions", { agentId });
    const sessionId = s.body.session.id;
    const res = await fetch(`${BASE}/api/sessions/${sessionId}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: user.cookieHeader() },
      body: JSON.stringify({ prompt: "帮我写份报告" }),
    });
    expect(res.status).toBe(200);
    return { sessionId, done: res.text() };
  }

  async function pendingQuestion(sessionId: string): Promise<Pending> {
    for (let i = 0; i < 120; i++) {
      const r = await user.get<{ pending: Pending[] }>(`/api/sessions/${sessionId}/approvals`);
      const q = r.body.pending?.find((p) => p.questions?.length);
      if (q) return q;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("没等到待回答的提问");
  }

  /** 网关收到的最后一次请求里,这次提问的工具结果文本 */
  function toolResultFor(toolUseId: string): { text: string; isError: boolean } | undefined {
    for (const req of gw.seenRequests as { messages?: { content?: unknown }[] }[]) {
      for (const msg of req?.messages ?? []) {
        if (!Array.isArray(msg.content)) continue;
        for (const b of msg.content as {
          type?: string;
          tool_use_id?: string;
          content?: unknown;
          is_error?: boolean;
        }[]) {
          if (b.type === "tool_result" && b.tool_use_id === toolUseId) {
            return { text: JSON.stringify(b.content), isError: b.is_error === true };
          }
        }
      }
    }
    return undefined;
  }

  it(
    "网页对话:运行停在提问上;提交回答(含自己填写的)后模型在同一轮收到答案;别人不能代答",
    { timeout: 60_000 },
    async () => {
      const { sessionId, done } = await startChat();
      const q = await pendingQuestion(sessionId);
      expect(q).toMatchObject({
        toolUseId: "toolu_answer",
        questions: [{ question: "报告用哪种格式?" }],
      });
      // 还没回答:模型那边只收到了第一次请求,没有收到工具结果
      expect(toolResultFor("toolu_answer")).toBeUndefined();

      const stranger = await newUser("ask-stranger");
      const denied = await stranger.post(`/api/sessions/${sessionId}/approvals`, {
        approvalId: q.id,
        decision: "approved",
        answers: ["PDF"],
      });
      expect([403, 404]).toContain(denied.status);

      const answered = await user.post(`/api/sessions/${sessionId}/approvals`, {
        approvalId: q.id,
        decision: "approved",
        answers: ["Word、另外要带目录"],
      });
      expect(answered.status, JSON.stringify(answered.body)).toBe(200);
      const stream = await done;
      expect(stream).toContain("好的,按你选的做。");
      const result = toolResultFor("toolu_answer");
      expect(result?.isError).toBe(false);
      expect(result?.text).toContain("The user answered");
      expect(result?.text).toContain("Word、另外要带目录");

      // 刷新后仍能看到回答:历史里有这次提问的工具结果
      const history = await user.get<{
        turns: { events: { kind: string; toolUseId?: string; text?: string }[] }[];
      }>(`/api/sessions/${sessionId}/history`);
      const events = history.body.turns?.flatMap((t) => t.events) ?? [];
      expect(events.some((e) => e.kind === "question")).toBe(true);
      expect(
        events.find((e) => e.kind === "tool_result" && e.toolUseId === "toolu_answer")?.text,
      ).toContain("Word、另外要带目录");
    },
  );

  it("选择不回答:模型收到拒绝说明,按自己的判断继续", { timeout: 60_000 }, async () => {
    const { sessionId, done } = await startChat();
    const q = await pendingQuestion(sessionId);
    const r = await user.post(`/api/sessions/${sessionId}/approvals`, {
      approvalId: q.id,
      decision: "denied",
    });
    expect(r.status).toBe(200);
    expect(await done).toContain("那我自己决定。");
    const result = toolResultFor("toolu_decline");
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain("用户选择不回答这些问题");
  });

  it("接口调用没人可问:不等,模型收到没有回答", { timeout: 60_000 }, async () => {
    const key = (await user.post<{ plaintext: string }>("/api/keys", { name: "ask", agentId })).body
      .plaintext;
    const api = new Client("ask-api");
    const invoked = await api.post<{ taskId: string }>(
      `/api/agents/${agentId}/invoke`,
      { input: "写报告" },
      { "X-Api-Key": key },
    );
    expect(invoked.status, JSON.stringify(invoked.body)).toBe(202);
    for (let i = 0; i < 120 && !toolResultFor("toolu_api"); i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(toolResultFor("toolu_api")?.text).toContain("did not answer");
  });

  it(
    "API Key 建的多轮会话:/run 遇到提问不等(没人对着提问卡片),不产生待回答,直接继续",
    { timeout: 60_000 },
    async () => {
      const key = (
        await user.post<{ plaintext: string }>("/api/keys", { name: "ask-session", agentId })
      ).body.plaintext;
      const api = new Client("ask-api-session");
      const created = await api.post<{ session: { id: string } }>(
        "/api/sessions",
        { agentId },
        { "X-Api-Key": key },
      );
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const sessionId = created.body.session.id;
      const started = Date.now();
      const run = api.post<{ status?: string }>(
        `/api/sessions/${sessionId}/run`,
        { prompt: "写报告", stream: false },
        { "X-Api-Key": key },
      );
      // 运行期间一直没有待回答
      let sawPending = false;
      let finished = false;
      void run.finally(() => {
        finished = true;
      });
      while (!finished && Date.now() - started < 30_000) {
        const p = await api.get<{ pending: Pending[] }>(`/api/sessions/${sessionId}/approvals`, {
          "X-Api-Key": key,
        });
        if (p.body.pending?.some((x) => x.questions?.length)) sawPending = true;
        await new Promise((r) => setTimeout(r, 200));
      }
      const res = await run;
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.status).toBe("success");
      expect(Date.now() - started).toBeLessThan(30_000);
      expect(sawPending).toBe(false);
      expect(toolResultFor("toolu_apisession")?.text).toContain("did not answer");
    },
  );
});
