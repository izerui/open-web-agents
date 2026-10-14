// steerRun 的答复只能如实:没确认送达就不能说送达。

import { steerRun } from "@/lib/modules/run/application/steer";
import { describe, expect, it } from "vitest";

describe("steerRun", () => {
  it("已入队但查结局出错:答 pending —— 不能说成送达,也不能说成失败(它可能已经送达)", async () => {
    const r = await steerRun(
      {
        channel: {
          offer: async () => "accepted",
          awaitOutcome: async () => {
            throw new Error("redis down");
          },
        },
      },
      { runId: "r1", id: "m1", text: "x" },
    );
    expect(r).toEqual({ id: "m1", outcome: "pending" });
  });

  it("受理请求本身没得到答复:答 unknown —— 它可能已经入队,既不能说没受理(会被重发两次),也不能说成功", async () => {
    const r = await steerRun(
      {
        channel: {
          offer: async () => {
            throw new Error("Redis offer 超过 2000ms 未返回");
          },
          awaitOutcome: async () => "delivered",
        },
      },
      { runId: "r1", id: "m1", text: "x" },
    );
    expect(r).toEqual({ id: "m1", outcome: "unknown" });
  });

  it("明确没受理才答 not_accepting;同一 id 已有结局直接答结局", async () => {
    const ask = (offer: "rejected" | "delivered" | "dropped") =>
      steerRun(
        { channel: { offer: async () => offer, awaitOutcome: async () => "pending" } },
        { runId: "r1", id: "m1", text: "x" },
      );
    expect((await ask("rejected")).outcome).toBe("not_accepting");
    expect((await ask("delivered")).outcome).toBe("delivered");
    expect((await ask("dropped")).outcome).toBe("dropped");
  });
});
