// 追加消息的发送策略:不确定时用同一 id 重试,只有明确的"没受理 / 没送达"才改作新消息。

import { sendSteer } from "@/features/workbench/steer-client";
import { describe, expect, it } from "vitest";

type Step = { status: number; body?: unknown } | "network";

function fakeFetch(steps: Step[]) {
  const bodies: unknown[] = [];
  const fn = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const s = steps.shift() ?? "network";
    if (s === "network") throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(s.body ?? {}), { status: s.status });
  }) as unknown as typeof fetch;
  return { fn, bodies };
}

const req = { sessionId: "s1", runId: "r1", id: "client-id-0001", text: "补充" };
const opts = (fetchFn: typeof fetch) => ({ fetchFn, sleep: async () => {} });

describe("sendSteer", () => {
  it("受理已执行但响应丢失(网络错误):用同一 id 重试拿到 delivered —— 不改作新消息", async () => {
    const f = fakeFetch(["network", { status: 200, body: { outcome: "delivered" } }]);
    expect(await sendSteer(req, opts(f.fn))).toEqual({ kind: "delivered", id: "client-id-0001" });
    expect(f.bodies).toEqual([
      { runId: "r1", id: "client-id-0001", text: "补充" },
      { runId: "r1", id: "client-id-0001", text: "补充" },
    ]);
  });

  it("服务端答 unknown(受理请求超时):用同一 id 再问,得到定局", async () => {
    const f = fakeFetch([
      { status: 202, body: { outcome: "unknown" } },
      { status: 202, body: { outcome: "pending" } },
    ]);
    expect((await sendSteer(req, opts(f.fn))).kind).toBe("pending");
    expect(new Set(f.bodies.map((b) => (b as { id: string }).id))).toEqual(
      new Set(["client-id-0001"]),
    );
  });

  it("5xx 也不当成没受理:重试", async () => {
    const f = fakeFetch([{ status: 503 }, { status: 200, body: { outcome: "delivered" } }]);
    expect((await sendSteer(req, opts(f.fn))).kind).toBe("delivered");
  });

  it("只有明确的 not_accepting / dropped 才改作新消息", async () => {
    for (const code of ["not_accepting", "dropped"]) {
      const f = fakeFetch([{ status: 409, body: { code } }]);
      expect((await sendSteer(req, opts(f.fn))).kind).toBe("resend");
    }
  });

  it("一直不确定:如实答 unconfirmed,不改作新消息", async () => {
    const f = fakeFetch([
      "network",
      { status: 202, body: { outcome: "unknown" } },
      { status: 500 },
      "network",
    ]);
    expect(await sendSteer(req, opts(f.fn))).toEqual({ kind: "unconfirmed", id: "client-id-0001" });
    expect(f.bodies).toHaveLength(4);
  });

  it("请求本身有问题(4xx):不重试,也不改作新消息", async () => {
    const f = fakeFetch([{ status: 404, body: { error: "该运行不属于本会话或不存在" } }]);
    expect(await sendSteer(req, opts(f.fn))).toEqual({
      kind: "invalid",
      id: "client-id-0001",
      message: "该运行不属于本会话或不存在",
    });
    expect(f.bodies).toHaveLength(1);
  });
});
