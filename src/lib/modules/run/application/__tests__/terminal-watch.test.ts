import { watchTerminal } from "@/lib/modules/run/application/terminal-watch";
import type { RunState } from "@/lib/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("watchTerminal", () => {
  it("库里落终态后补发一条 result 事件,只发一次", async () => {
    let status: RunState = "running";
    const got: unknown[] = [];
    const stop = watchTerminal(
      {
        getResult: async () => ({
          status,
          structured: null,
          finalText: null,
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
      {
        getResult: async () => ({ status: "success", structured: 1, finalText: "ok", error: null }),
      },
      "r1",
      (e) => got.push(e),
      5,
    );
    stop();
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual([]);
  });

  describe("数据库不返回", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const row = (status: RunState) => ({
      status,
      structured: null,
      finalText: "答案",
      error: null,
    });

    it("查询不重叠:上一条挂着时不再发新查询", async () => {
      vi.useFakeTimers();
      let calls = 0;
      const stop = watchTerminal(
        {
          getResult: () => {
            calls++;
            return new Promise(() => {}); // 永不返回
          },
        },
        "r1",
        () => {},
        3_000,
        10_000,
      );
      await vi.advanceTimersByTimeAsync(3_000);
      expect(calls).toBe(1);
      // 原先每 3 秒一条:到 12 秒时会有 4 条挂着
      await vi.advanceTimersByTimeAsync(9_000);
      expect(calls).toBe(1);
      stop();
    });

    it("单次查询超过上限就放弃,下一轮照常查;数据库恢复后仍能收尾", async () => {
      vi.useFakeTimers();
      let calls = 0;
      const got: unknown[] = [];
      const stop = watchTerminal(
        {
          getResult: () => {
            calls++;
            // 第一次挂住,之后恢复并已落终态
            return calls === 1 ? new Promise(() => {}) : Promise.resolve(row("success"));
          },
        },
        "r1",
        (e) => got.push(e),
        3_000,
        10_000,
      );
      await vi.advanceTimersByTimeAsync(3_000 + 10_000 - 1);
      expect(calls).toBe(1);
      expect(got).toEqual([]);
      // 第 13 秒放弃第一条,再等一个间隔发第二条
      await vi.advanceTimersByTimeAsync(1 + 3_000);
      expect(calls).toBe(2);
      expect(got).toMatchObject([{ kind: "result", status: "success", summary: "答案" }]);
      stop();
    });

    it("查询返回前被取消:结果回来也不回调,也不再排下一次", async () => {
      vi.useFakeTimers();
      let calls = 0;
      let release!: (v: ReturnType<typeof row>) => void;
      const got: unknown[] = [];
      const stop = watchTerminal(
        {
          getResult: () => {
            calls++;
            return new Promise((r) => {
              release = r;
            });
          },
        },
        "r1",
        (e) => got.push(e),
        3_000,
        10_000,
      );
      await vi.advanceTimersByTimeAsync(3_000);
      stop();
      release(row("success"));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(got).toEqual([]);
      expect(calls).toBe(1);
    });
  });
});
