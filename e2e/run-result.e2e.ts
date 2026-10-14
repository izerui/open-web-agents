// 统一的对外运行结果契约:/result 轮询与阻塞模式(stream:false)字段一致。
// e2e 屏蔽了模型调用,运行很快以失败收尾 —— 正好覆盖 error 的形状(对象而不是字符串)。
// webhook 载荷由单测(runFinishedPayload 与 toRunResult 逐字段比对)覆盖。

import { beforeAll, describe, expect, it } from "vitest";
import { Client, newUser, serverUp } from "./client";

const CONTRACT = [
  "taskId",
  "status",
  "done",
  "agentVersion",
  "structured",
  "salvaged",
  "text",
  "error",
  "cost",
  "startedAt",
  "endedAt",
];

describe("统一的运行结果契约", () => {
  let owner: Client;
  let agentId = "";
  let key = "";
  const anon = new Client("anon-res");

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
    owner = await newUser("result");
    agentId =
      (
        await owner.post<{ agent?: { id: string } }>("/api/agents", {
          name: `res-${Date.now()}`,
          config: { systemPrompt: "p", model: "sonnet" },
        })
      ).body.agent?.id ?? "";
    key =
      (await owner.post<{ plaintext?: string }>("/api/keys", { name: "r", agentId })).body
        .plaintext ?? "";
  });

  it(
    "/result:契约字段齐全;结束后 done=true、有起止时间;error 是对象;summary 同 text",
    { timeout: 30_000 },
    async () => {
      const taskId = (
        await anon.post<{ taskId?: string }>(
          `/api/agents/${agentId}/invoke`,
          { input: "hi" },
          {
            "X-Api-Key": key,
          },
        )
      ).body.taskId;
      let r: Record<string, unknown> = {};
      for (let i = 0; i < 40; i++) {
        r = (
          await anon.get<Record<string, unknown>>(`/api/agents/${taskId}/result`, {
            "X-Api-Key": key,
          })
        ).body;
        if (r.done) break;
        await new Promise((ok) => setTimeout(ok, 300));
      }
      for (const k of CONTRACT) expect(r).toHaveProperty(k);
      expect(r).toMatchObject({ taskId, done: true, status: "failed", salvaged: false });
      expect(typeof r.startedAt).toBe("string");
      expect(typeof r.endedAt).toBe("string");
      expect(r.error).toMatchObject({ kind: expect.any(String), message: expect.any(String) });
      expect(r.summary).toEqual(r.text);
    },
  );

  it(
    "阻塞模式:同一份契约字段 + 过程信息;error 是对象(不再是字符串)",
    { timeout: 30_000 },
    async () => {
      const s = (await owner.post<{ session?: { id: string } }>("/api/sessions", { agentId })).body
        .session;
      const r = await owner.post<Record<string, unknown>>(`/api/sessions/${s?.id}/run`, {
        prompt: "hi",
        stream: false,
      });
      for (const k of CONTRACT) expect(r.body).toHaveProperty(k);
      expect(r.body.taskId).toBe(r.body.runId);
      expect(r.body).toMatchObject({ done: true, status: "failed" });
      expect(typeof r.body.error).toBe("object");
      // 起止时间只在库记录里有:断言它们,才能证明阻塞响应读的是库记录而不是只拼事件
      expect(typeof r.body.startedAt).toBe("string");
      expect(typeof r.body.endedAt).toBe("string");
      expect(r.body.error).toMatchObject({ message: expect.any(String) });
      expect(Array.isArray(r.body.toolCalls)).toBe(true);
      expect(r.body.usage).toMatchObject({ input: expect.any(Number), output: expect.any(Number) });
    },
  );
});
