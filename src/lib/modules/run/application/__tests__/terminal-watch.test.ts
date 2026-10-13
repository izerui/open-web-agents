import { watchTerminal } from "@/lib/modules/run/application/terminal-watch";
import type { RunState } from "@/lib/shared";
import { describe, expect, it } from "vitest";

describe("watchTerminal", () => {
  it("库里落终态后补发一条 result 事件,只发一次", async () => {
    let status: RunState = "running";
    const got: unknown[] = [];
    const stop = watchTerminal(
      {
        getResult: async () => ({
          status,
          structured: null,
          summary: null,
          error: { kind: "worker_lost", message: "worker 失联" },
        }),
      },
      "r1",
      (e) => got.push(e),
      5,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual([]);
    status = "failed";
    await new Promise((r) => setTimeout(r, 30));
    expect(got).toEqual([
      {
        kind: "result",
        status: "failed",
        summary: "worker 失联",
        runId: "r1",
        structured: undefined,
      },
    ]);
    stop();
  });

  it("取消后不再回调", async () => {
    const got: unknown[] = [];
    const stop = watchTerminal(
      { getResult: async () => ({ status: "success", structured: 1, summary: "ok", error: null }) },
      "r1",
      (e) => got.push(e),
      5,
    );
    stop();
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual([]);
  });
});
