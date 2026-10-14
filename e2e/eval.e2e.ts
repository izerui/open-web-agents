// 智能体评测 —— 真实服务。e2e 屏蔽了模型,运行都会失败:正好验证判分(期望成功的判失败并说明原因,
// 期望失败的判通过)、评测不推回调、不进会话列表、权限。

import { beforeAll, describe, expect, it } from "vitest";
import { type Client, newUser, serverUp } from "./client";

type Run = { id: string; status: string; total: number; passed: number; failed: number };
type Result = { caseId: string; status: string; failures?: string[]; taskId?: string };

describe("智能体评测", () => {
  let owner: Client;
  let reader: Client;
  let stranger: Client;
  let agentId = "";
  let emptyAgentId = "";

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
    owner = await newUser("eval");
    reader = await newUser("eval-r");
    stranger = await newUser("eval-x");
    const mk = async (name: string, extra: Record<string, unknown> = {}) =>
      (
        await owner.post<{ agent?: { id: string } }>("/api/agents", {
          name,
          config: { systemPrompt: "p", model: "sonnet" },
          ...extra,
        })
      ).body.agent?.id ?? "";
    // 配了回调地址:用来确认评测不推回调
    agentId = await mk(`eval-${Date.now()}`, {
      webhookUrl: "https://hook.eval.owa-e2e.invalid/in",
    });
    emptyAgentId = await mk(`eval-empty-${Date.now()}`);
    const email = (await reader.get<{ user?: { email: string } }>("/api/auth")).body.user?.email;
    await owner.post(`/api/agents/${agentId}/share`, { target: email, permission: "read" });
  });

  const cases = `/api/agents/${"%ID%"}/evals/cases`;
  const url = (p: string, id = agentId) => p.replace("%ID%", id);

  it("用例的增删改与校验", async () => {
    const bad = await owner.post(url(cases), {
      name: "坏的",
      input: "x",
      assertions: { maxCostUsd: -1 },
    });
    expect(bad.status).toBe(400);
    expect((await owner.post(url(cases), { name: "", input: "x" })).status).toBe(400);

    const a = await owner.post<{ case?: { id: string } }>(url(cases), {
      name: "应当成功",
      input: "审查这份合同",
      assertions: { contains: ["完成"] },
    });
    expect(a.status).toBe(201);
    const b = await owner.post<{ case?: { id: string } }>(url(cases), {
      name: "应当失败",
      input: "临时名",
      assertions: { expectSuccess: false },
    });
    const put = await owner.req("PUT", `${url(cases)}/${b.body.case?.id}`, {
      body: { name: "应当失败", input: "一个会失败的请求", assertions: { expectSuccess: false } },
    });
    expect(put.status).toBe(200);
    const list = await owner.get<{ cases?: { name: string }[] }>(url(cases));
    expect(list.body.cases?.map((c) => c.name)).toEqual(["应当成功", "应当失败"]);
  });

  it(
    "跑一次评测:期望成功的判失败并说明原因,期望失败的判通过;评测收尾",
    { timeout: 60_000 },
    async () => {
      const start = await owner.post<{ run?: Run }>(`/api/agents/${agentId}/evals/runs`, {
        target: "draft",
      });
      expect(start.status).toBe(202);
      expect(start.body.run).toMatchObject({ status: "running", total: 2 });
      const id = start.body.run?.id;

      let detail: { run?: Run; results?: Result[] } = {};
      for (let i = 0; i < 100; i++) {
        detail = (await owner.get<typeof detail>(`/api/agents/${agentId}/evals/runs/${id}`)).body;
        if (detail.run?.status === "done") break;
        await new Promise((ok) => setTimeout(ok, 300));
      }
      expect(detail.run).toMatchObject({ status: "done", passed: 1, failed: 1 });
      const byStatus = Object.fromEntries((detail.results ?? []).map((r) => [r.status, r]));
      expect(byStatus.failed?.failures?.[0]).toMatch(/期望运行成功/);
      expect(byStatus.passed).toBeDefined();

      // 评测不推回调:这些任务在投递记录里不出现
      await new Promise((ok) => setTimeout(ok, 3_000));
      const deliveries = await owner.get<{ items?: { runId?: string }[] }>(
        `/api/agents/${agentId}/webhook/deliveries`,
      );
      const taskIds = new Set((detail.results ?? []).map((r) => r.taskId));
      expect((deliveries.body.items ?? []).filter((d) => taskIds.has(d.runId))).toEqual([]);

      // 评测会话不进工作台的会话列表
      const sessions = await owner.get<{ sessions?: { title?: string }[] }>("/api/sessions");
      expect((sessions.body.sessions ?? []).some((s) => s.title?.startsWith("评测:"))).toBe(false);

      const runs = await owner.get<{ runs?: Run[] }>(`/api/agents/${agentId}/evals/runs`);
      expect(runs.body.runs?.[0]?.id).toBe(id);
    },
  );

  it("没有用例 409;版本不存在 404;target 不合法 400", async () => {
    expect((await owner.post(`/api/agents/${emptyAgentId}/evals/runs`, {})).status).toBe(409);
    expect((await owner.post(`/api/agents/${agentId}/evals/runs`, { target: 99 })).status).toBe(
      404,
    );
    expect((await owner.post(`/api/agents/${agentId}/evals/runs`, { target: "x" })).status).toBe(
      400,
    );
  });

  it("权限:只读协作者 403,无关的人 404;别的智能体的用例 id 改不了", async () => {
    expect((await reader.get(url(cases))).status).toBe(403);
    expect((await reader.post(`/api/agents/${agentId}/evals/runs`, {})).status).toBe(403);
    expect((await stranger.get(url(cases))).status).toBe(404);
    const mine = await owner.get<{ cases?: { id: string }[] }>(url(cases));
    const someCase = mine.body.cases?.[0]?.id;
    const cross = await owner.req("DELETE", `${url(cases, emptyAgentId)}/${someCase}`);
    expect(cross.status).toBe(404);
  });

  it("进审计", async () => {
    const a = await owner.get<{ items?: { action: string }[] }>("/api/audit?action=eval.run");
    expect((a.body.items ?? []).length).toBeGreaterThan(0);
  });
});
