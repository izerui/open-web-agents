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

const state: {
  getResult: (id: string) => Promise<unknown>;
  reads: number;
  sessionGet: (id: string) => Promise<unknown>;
  /** worker 发到总线上的事件(runId 由测试替换) */
  events: (runId: string) => AgentEvent[];
} = {
  getResult: async () => null,
  reads: 0,
  sessionGet: async (_id: string): Promise<unknown> => ({
    id: "s1",
    agentId: "a1",
    workspaceDir: "/ws",
  }),
  events: (runId) => [
    { kind: "text", text: "事件里的正文" } as AgentEvent,
    { kind: "result", status: "success", runId } as AgentEvent,
  ],
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
      sessions: { get: (id: string) => state.sessionGet(id) },
      storage: { tree: async () => [] },
      admission: { admit: async () => ({ prompt: "hi" }) },
      // 阻塞模式的补读走有时限的结果读取源(runResults),不再直接用 runs
      runResults: {
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
              state.events(r.runId).forEach((e, i) => cb(e, `${i + 1}-0`));
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
  const defaultEvents = state.events;
  const defaultSessionGet = state.sessionGet;
  beforeEach(() => {
    state.reads = 0;
    state.events = defaultEvents;
    state.sessionGet = defaultSessionGet;
  });

  it(
    "附上工作目录的文件清单;查会话永不返回时清单为 null,响应仍在上限内结束",
    { timeout: 10_000 },
    async () => {
      state.getResult = async () => RECORD;
      const ok = await (await runBlocking()).json();
      expect(ok).toMatchObject({ files: [], filesTruncated: false });

      // 鉴权时查会话照常返回;之后为文件清单查会话时数据库不返回
      let calls = 0;
      state.sessionGet = (id) => (calls++ === 0 ? defaultSessionGet(id) : new Promise(() => {}));
      const t0 = Date.now();
      const res = await runBlocking();
      expect(Date.now() - t0).toBeLessThan(3_500);
      expect(await res.json()).toMatchObject({ status: "success", files: null });
    },
  );

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
    // 这里只是响应不再等;底层查询由结果读取源自己限时结束(见 bounded-result-reader)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/改用事件拼装响应/));
    warn.mockRestore();
  });

  it(
    "过程正文丢了、只收到带 summary 的成功终态,补读又永不兑现:有界结束且正文完整",
    { timeout: 10_000 },
    async () => {
      state.events = (runId) => [
        { kind: "result", status: "success", summary: "终态里的完整答案", runId } as AgentEvent,
      ];
      state.getResult = () => new Promise(() => {});
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const start = Date.now();
      const res = await runBlocking();
      expect(Date.now() - start).toBeLessThan(3_500);
      warn.mockRestore();
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        status: "success",
        done: true,
        text: "终态里的完整答案",
        error: null,
      });
    },
  );

  it("成功终态的 summary 优先于过程增量(增量可能不全)", { timeout: 10_000 }, async () => {
    state.events = (runId) => [
      { kind: "text", text: "只到一半" } as AgentEvent,
      { kind: "result", status: "success", summary: "完整答案", runId } as AgentEvent,
    ];
    state.getResult = async () => {
      throw new Error("db down");
    };
    expect(await (await runBlocking()).json()).toMatchObject({ text: "完整答案" });
  });

  it("失败终态的 summary 是错误信息:进 error,不当正文", { timeout: 10_000 }, async () => {
    state.events = (runId) => [
      { kind: "result", status: "failed", summary: "模型调用失败", runId } as AgentEvent,
    ];
    state.getResult = async () => {
      throw new Error("db down");
    };
    const res = await runBlocking();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      status: "failed",
      text: null,
      error: { message: "模型调用失败" },
    });
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
