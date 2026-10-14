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
        newId: () => "m1",
      },
      { runId: "r1", text: "x" },
    );
    expect(r).toEqual({ id: "m1", outcome: "pending" });
  });

  it("入队本身失败:抛给调用方(接口答 503),不吞成某个结局", async () => {
    await expect(
      steerRun(
        {
          channel: {
            offer: async () => {
              throw new Error("redis down");
            },
            awaitOutcome: async () => "delivered",
          },
          newId: () => "m1",
        },
        { runId: "r1", text: "x" },
      ),
    ).rejects.toThrow(/redis down/);
  });
});
