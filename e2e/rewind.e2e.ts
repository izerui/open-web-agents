// "从某一轮重来"的接口边界。e2e 屏蔽了模型,运行不产生 transcript 范围 —— 正好覆盖:
// 重来首轮(之前没有对话)照常受理;重来之后的轮次,前一轮没有记录,如实答 rewind_unavailable。
// 真正回到中间状态的语义由 scripts/sdk-probe/rewind-e2e.ts(真实 SDK)验证。

import { beforeAll, describe, expect, it } from "vitest";
import { type Client, newUser, serverUp } from "./client";

describe("从某一轮重来(rewind)", () => {
  let owner: Client;
  let sessionId = "";
  const runIds: string[] = [];

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
    owner = await newUser("rewind");
    const agentId =
      (
        await owner.post<{ agent?: { id: string } }>("/api/agents", {
          name: `rw-${Date.now()}`,
          config: { systemPrompt: "p", model: "sonnet" },
        })
      ).body.agent?.id ?? "";
    sessionId =
      (await owner.post<{ session?: { id: string } }>("/api/sessions", { agentId })).body.session
        ?.id ?? "";
    for (const prompt of ["第一轮", "第二轮"]) {
      const r = await owner.post<{ runId?: string }>(`/api/sessions/${sessionId}/run`, {
        prompt,
        stream: false,
      });
      runIds.push(r.body.runId ?? "");
    }
  });

  it("重来首轮:之前没有对话,照常受理", async () => {
    const r = await owner.post<{ runId?: string; mode?: string }>(
      `/api/sessions/${sessionId}/branch`,
      { fromRunId: runIds[0], mode: "rewind", prompt: "第一轮换个说法" },
    );
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ mode: "rewind", resumeAnchor: null });
  });

  it("前一轮定位不了(没有记录):409 rewind_unavailable,而不是猜一个状态", async () => {
    // (e2e 里运行不产生 transcript 范围)
    const r = await owner.post<{ code?: string }>(`/api/sessions/${sessionId}/branch`, {
      fromRunId: runIds[1],
      mode: "rewind",
      prompt: "第二轮换个说法",
    });
    // 第二轮续接了第一轮的会话(有锚点)才有"之前的状态"需要定位;没有锚点就等同重来首轮。
    // 先看清是哪种,再断言对应的结果 —— 不接受两可
    const list = await owner.get<{ runs?: { id: string; resumeAnchor?: string | null }[] }>(
      `/api/sessions/${sessionId}/branch`,
    );
    const second = list.body.runs?.find((x) => x.id === runIds[1]);
    if (second?.resumeAnchor) {
      expect(r.status).toBe(409);
      expect(r.body.code).toBe("rewind_unavailable");
    } else {
      expect(r.status).toBe(202);
    }
  });
});
