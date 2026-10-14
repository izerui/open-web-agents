// 运行中途追加消息的接口边界。e2e 屏蔽了模型,运行很快以失败收尾 —— 正好覆盖
// "运行已收尾:不受理"与越权、入口限制;送达路径由单测与 scripts/sdk-probe/steer-e2e.ts(真实 SDK)覆盖。

import { beforeAll, describe, expect, it } from "vitest";
import { Client, newUser, serverUp } from "./client";

describe("运行中途追加消息", () => {
  let owner: Client;
  let stranger: Client;
  let agentId = "";
  let sessionId = "";
  let runId = "";

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
    owner = await newUser("steer");
    stranger = await newUser("steer-x");
    agentId =
      (
        await owner.post<{ agent?: { id: string } }>("/api/agents", {
          name: `steer-${Date.now()}`,
          config: { systemPrompt: "p", model: "sonnet" },
        })
      ).body.agent?.id ?? "";
    sessionId =
      (await owner.post<{ session?: { id: string } }>("/api/sessions", { agentId })).body.session
        ?.id ?? "";
    const r = await owner.post<{ runId?: string }>(`/api/sessions/${sessionId}/run`, {
      prompt: "hi",
      stream: false,
    });
    runId = r.body.runId ?? "";
    expect(runId).toBeTruthy();
  });

  it("运行已收尾:409 not_accepting(这条没有受理,应作为新消息发送)", async () => {
    const r = await owner.post<{ code?: string }>(`/api/sessions/${sessionId}/steer`, {
      runId,
      text: "补充一句",
    });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("not_accepting");
  });

  it("参数缺失 400;不属于本会话的运行 404", async () => {
    expect((await owner.post(`/api/sessions/${sessionId}/steer`, { text: "x" })).status).toBe(400);
    expect(
      (await owner.post(`/api/sessions/${sessionId}/steer`, { runId, text: " " })).status,
    ).toBe(400);
    const other =
      (await owner.post<{ session?: { id: string } }>("/api/sessions", { agentId })).body.session
        ?.id ?? "";
    expect((await owner.post(`/api/sessions/${other}/steer`, { runId, text: "x" })).status).toBe(
      404,
    );
  });

  it("别人的会话:拿不到(403/404),未登录 401", async () => {
    const r = await stranger.post(`/api/sessions/${sessionId}/steer`, { runId, text: "x" });
    expect([403, 404]).toContain(r.status);
    const anon = new Client("anon-steer");
    expect((await anon.post(`/api/sessions/${sessionId}/steer`, { runId, text: "x" })).status).toBe(
      401,
    );
  });
});
