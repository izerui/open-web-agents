// 阻塞模式(stream:false)收到终态事件后补读结果记录 —— 这次补读必须有等待上限。
//
// 只替换 container,从 HTTP 处理函数这一层断言:数据库在终态事件之后一直不返回时,
// 响应仍在上限内结束,用事件拼出的兜底结果收尾。

import type { AgentEvent } from "@/lib/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const RECORD = {
  id: "r",
  status: "success" as const,
  structured: null,
  salvaged: false,
  finalText: "库里的最终回答",
  cost: null,
  error: null,
  agentVersion: null,
  startedAt: new Date("2026-01-01T00:00:00Z"),
  endedAt: new Date("2026-01-01T00:00:05Z"),
};

const state: { getResult: (id: string) => Promise<unknown>; reads: number } = {
  getResult: async () => null,
  reads: 0,
};

vi.mock("@/lib/container", () => {
  const handlers = new Map<string, (e: AgentEvent, id: string) => void>();
  return {
    getContainer: () => ({
      auth: {
        resolveWeb: async () => ({ type: "web", userId: "u1" }),
        assertSessionAccess: async () => {},
        assertCanInvoke: async () => {},
      },
      sessions: { get: async () => ({ id: "s1", agentId: "a1" }) },
      admission: { admit: async () => ({ prompt: "hi" }) },
      runs: {
        getResult: (id: string) => {
          state.reads++;
          return state.getResult(id);
        },
      },
      bus: {
        subscribe: (topic: string, cb: (e: AgentEvent, id: string) => void) => {
          handlers.set(topic, cb);
          return () => handlers.delete(topic);
        },
        publish: async () => {},
      },
      // 入队成功后,worker 跑完:总线上依次到达正文与成功终态
      enqueuer: {
        enqueue: async (r: { runId: string; sessionId: string }) => {
          setTimeout(() => {
            for (const [topic, cb] of handlers) {
              if (!topic.includes(r.runId)) continue;
              cb({ kind: "text", text: "事件里的正文" } as AgentEvent, "1-0");
              cb({ kind: "result", status: "success", runId: r.runId } as AgentEvent, "2-0");
            }
          }, 0);
        },
      },
    }),
  };
});

async function runBlocking() {
  const { POST } = await import("../route");
  return POST(
    new Request("http://x/api/sessions/s1/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hi", stream: false }),
    }),
    { params: Promise.resolve({ id: "s1" }) },
  );
}

describe("阻塞模式:终态之后补读结果记录", () => {
  beforeEach(() => {
    state.reads = 0;
  });

  it("补读永不兑现:仍在等待上限内结束,用事件兜底收尾", { timeout: 10_000 }, async () => {
    state.getResult = () => new Promise(() => {}); // 数据库不返回
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const start = Date.now();
    const res = await runBlocking();
    const elapsed = Date.now() - start;

    // 上限 2 秒;留余量但远小于"挂住"
    expect(elapsed).toBeLessThan(3_500);
    expect(state.reads).toBeGreaterThanOrEqual(1);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      status: "success",
      done: true,
      text: "事件里的正文",
      startedAt: null, // 兜底:起止时间只有库里有
      error: null,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/底层查询未取消/));
    warn.mockRestore();
  });

  it("补读失败(拒绝):立即用事件兜底", { timeout: 10_000 }, async () => {
    state.getResult = async () => {
      throw new Error("db down");
    };
    const start = Date.now();
    const res = await runBlocking();
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(await res.json()).toMatchObject({
      status: "success",
      text: "事件里的正文",
      startedAt: null,
    });
  });

  it("补读正常:结果契约取自库里的记录", { timeout: 10_000 }, async () => {
    state.getResult = async () => RECORD;
    const res = await runBlocking();
    expect(await res.json()).toMatchObject({
      status: "success",
      text: "库里的最终回答",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:05.000Z",
    });
  });
});
