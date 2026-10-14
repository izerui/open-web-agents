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

    it("查询永不返回:无论过多久都只有这一条,不会发新查询", async () => {
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
      );
      await vi.advanceTimersByTimeAsync(3_000);
      expect(calls).toBe(1);
      // 推进很多个间隔(原先每 3 秒一条;"超时就排下一次"的版本也会每 13 秒多一条)
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(calls).toBe(1);
      stop();
    });

    it("挂了很久的那条终于返回终态:照常收尾,且只回调一次", async () => {
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
      );
      await vi.advanceTimersByTimeAsync(3_000 + 5 * 60_000);
      expect(calls).toBe(1);
      release(row("success"));
      await vi.advanceTimersByTimeAsync(0);
      expect(got).toMatchObject([{ kind: "result", status: "success", summary: "答案" }]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toBe(1);
      expect(got).toHaveLength(1);
      stop();
    });

    it("挂着的那条最后返回未终态或被拒绝:这条结束后才排下一次", async () => {
      vi.useFakeTimers();
      let calls = 0;
      const pending: ((v: ReturnType<typeof row>) => void)[] = [];
      let rejectNext: ((e: Error) => void) | undefined;
      const stop = watchTerminal(
        {
          getResult: () => {
            calls++;
            return new Promise((resolve, reject) => {
              pending.push(resolve);
              rejectNext = reject;
            });
          },
        },
        "r1",
        () => {},
        3_000,
      );
      await vi.advanceTimersByTimeAsync(3_000 + 60_000);
      expect(calls).toBe(1);
      pending[0]?.(row("running")); // 返回了,还没结束
      await vi.advanceTimersByTimeAsync(3_000 - 1);
      expect(calls).toBe(1); // 返回之后再等一个间隔
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(2);
      rejectNext?.(new Error("db down")); // 第二条被驱动拒绝
      await vi.advanceTimersByTimeAsync(3_000);
      expect(calls).toBe(3);
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
