// RunRepo 的【端口契约】测试套件。
//
// 内存 fake 与 MySQL adapter 跑同一套断言 —— 这是"基础设施可替换"从口号变成事实的地方:
// 只要新 adapter 通过本套件,上层就能无感替换。
//
// 时间一律由调用方传入(now 参数),不读系统时钟,故契约可确定性地断言租约边界。

import type { RunRepo } from "@/lib/modules/run/ports";
import { describe, expect, it } from "vitest";

export interface ContractHarness {
  /** 每个用例前拿一个干净的 repo。 */
  makeRepo(): Promise<RunRepo>;
  /** 用例后清理(关连接等)。 */
  cleanup?(): Promise<void>;
}

export function runRepoContract(name: string, harness: ContractHarness): void {
  describe(`RunRepo 契约:${name}`, () => {
    it("新建的 run 处于 pending 且无租约", async () => {
      const repo = await harness.makeRepo();
      const run = await repo.create({ id: "r1", sessionId: "s1" });
      expect(run.state).toBe("pending");
      expect(run.leaseUntil).toBeNull();
    });

    it("认领 pending 并置租约到 now+leaseMs", async () => {
      const repo = await harness.makeRepo();
      await repo.create({ id: "r1", sessionId: "s1" });
      const claimed = await repo.claimNext(1000, 100);
      expect(claimed?.id).toBe("r1");
      expect(claimed?.state).toBe("running");
      expect(claimed?.leaseUntil).toBe(1100);
    });

    it("队列空时认领返回 null", async () => {
      const repo = await harness.makeRepo();
      expect(await repo.claimNext(1000, 100)).toBeNull();
    });

    it("租约未过期的 running 不会被重复认领", async () => {
      const repo = await harness.makeRepo();
      await repo.create({ id: "r1", sessionId: "s1" });
      await repo.claimNext(1000, 100);
      expect(await repo.claimNext(1000, 500)).toBeNull();
    });

    it("租约过期后可被重新认领(worker 崩溃兜底)", async () => {
      const repo = await harness.makeRepo();
      await repo.create({ id: "r1", sessionId: "s1" });
      await repo.claimNext(1000, 100);
      const again = await repo.claimNext(1000, 2000);
      expect(again?.id).toBe("r1");
    });

    it("并发认领同一个 run 只有一个成功(乐观锁)", async () => {
      const repo = await harness.makeRepo();
      await repo.create({ id: "r1", sessionId: "s1" });
      const results = await Promise.all([
        repo.claimNext(1000, 100),
        repo.claimNext(1000, 100),
        repo.claimNext(1000, 100),
      ]);
      expect(results.filter((r) => r !== null)).toHaveLength(1);
    });

    it("touch 续租可阻止被抢走", async () => {
      const repo = await harness.makeRepo();
      await repo.create({ id: "r1", sessionId: "s1" });
      await repo.claimNext(1000, 100);
      await repo.touch("r1", 5000);
      expect(await repo.claimNext(1000, 2000)).toBeNull();
    });

    it("complete 落终态并清租约,不再被认领", async () => {
      const repo = await harness.makeRepo();
      await repo.create({ id: "r1", sessionId: "s1" });
      await repo.claimNext(1000, 100);
      await repo.complete("r1", "success");
      const run = await repo.get("r1");
      expect(run?.state).toBe("success");
      expect(run?.leaseUntil).toBeNull();
      expect(await repo.claimNext(1000, 9999)).toBeNull();
    });

    it("reclaimOrphans 把过期 running 打回 pending", async () => {
      const repo = await harness.makeRepo();
      await repo.create({ id: "r1", sessionId: "s1" });
      await repo.claimNext(1000, 100);
      expect(await repo.reclaimOrphans(2000)).toBe(1);
      expect((await repo.get("r1"))?.state).toBe("pending");
    });

    it("reclaimOrphans 不动租约内的 running", async () => {
      const repo = await harness.makeRepo();
      await repo.create({ id: "r1", sessionId: "s1" });
      await repo.claimNext(1000, 100);
      expect(await repo.reclaimOrphans(500)).toBe(0);
    });

    it("reclaimOrphans 不动已完成的 run", async () => {
      const repo = await harness.makeRepo();
      await repo.create({ id: "r1", sessionId: "s1" });
      await repo.claimNext(1000, 100);
      await repo.complete("r1", "success");
      expect(await repo.reclaimOrphans(99999)).toBe(0);
    });

    it("多个 run 逐个认领,不漏不重", async () => {
      const repo = await harness.makeRepo();
      await repo.create({ id: "r1", sessionId: "s1" });
      await repo.create({ id: "r2", sessionId: "s1" });
      const a = await repo.claimNext(1000, 100);
      const b = await repo.claimNext(1000, 100);
      expect(new Set([a?.id, b?.id])).toEqual(new Set(["r1", "r2"]));
      expect(await repo.claimNext(1000, 100)).toBeNull();
    });

    it("get 不存在的 run 返回 null", async () => {
      const repo = await harness.makeRepo();
      expect(await repo.get("nope")).toBeNull();
    });

    // 取消。状态机里 pending/running --cancel--> cancelled 两条边一直写着,
    // 但曾经【没有任何生产者】—— 界面上的"停止"只调 fetch 的 abort,而运行不绑定在
    // 那个 HTTP 请求上,服务端 agent 继续跑到底并落 success。cancelled 是不可达状态,
    // 用户以为停了其实没停,费用与副作用继续产生。
    describe("cancel", () => {
      it("排队中的运行可以取消", async () => {
        const repo = await harness.makeRepo();
        await repo.create({ id: "r1", sessionId: "s1" });
        expect(await repo.cancel("r1")).toBe(true);
        expect((await repo.get("r1"))?.state).toBe("cancelled");
      });

      it("执行中的运行可以取消,并清掉租约", async () => {
        const repo = await harness.makeRepo();
        await repo.create({ id: "r1", sessionId: "s1" });
        await repo.claimNext(30_000, 1000);
        expect(await repo.cancel("r1")).toBe(true);
        const r = await repo.get("r1");
        expect(r?.state).toBe("cancelled");
        expect(r?.leaseUntil).toBeNull();
      });

      it("【中止执行】取消后续租返回 false —— 这是 worker 中止本轮的唯一信号", async () => {
        const repo = await harness.makeRepo();
        await repo.create({ id: "r1", sessionId: "s1" });
        const claimed = await repo.claimNext(30_000, 1000);
        expect(await repo.touch("r1", 60_000, claimed?.fence)).toBe(true);
        await repo.cancel("r1");
        expect(await repo.touch("r1", 60_000, claimed?.fence)).toBe(false);
      });

      it("取消后 worker 写不回结果 —— 不能把 cancelled 翻成 success", async () => {
        const repo = await harness.makeRepo();
        await repo.create({ id: "r1", sessionId: "s1" });
        const claimed = await repo.claimNext(30_000, 1000);
        await repo.cancel("r1");
        expect(await repo.complete("r1", "success", claimed?.fence)).toBe(false);
        expect((await repo.get("r1"))?.state).toBe("cancelled");
      });

      it("已是终态的运行取消无效(返回 false,状态不变)", async () => {
        const repo = await harness.makeRepo();
        await repo.create({ id: "r1", sessionId: "s1" });
        const c = await repo.claimNext(30_000, 1000);
        await repo.complete("r1", "success", c?.fence);
        expect(await repo.cancel("r1")).toBe(false);
        expect((await repo.get("r1"))?.state).toBe("success");
      });

      it("取消不存在的 run 返回 false", async () => {
        const repo = await harness.makeRepo();
        expect(await repo.cancel("nope")).toBe(false);
      });

      it("已取消的运行不会再被认领", async () => {
        const repo = await harness.makeRepo();
        await repo.create({ id: "r1", sessionId: "s1" });
        await repo.cancel("r1");
        expect(await repo.claimNext(1000, 99999)).toBeNull();
      });
    });

    describe("会话维度聚合", () => {
      it("按会话分别计数,不串味", async () => {
        const repo = await harness.makeRepo();
        await repo.create({ id: "a1", sessionId: "s1" });
        await repo.create({ id: "a2", sessionId: "s1" });
        await repo.create({ id: "b1", sessionId: "s2" });

        const stats = await repo.statsBySessions(["s1", "s2"]);
        expect(stats.get("s1")?.runs).toBe(2);
        expect(stats.get("s2")?.runs).toBe(1);
      });

      it("一轮都没跑过的会话不出现在结果里(调用方按 0 处理)", async () => {
        const repo = await harness.makeRepo();
        await repo.create({ id: "a1", sessionId: "s1" });

        const stats = await repo.statsBySessions(["s1", "empty"]);
        expect(stats.has("empty")).toBe(false);
      });

      it("只统计问到的会话", async () => {
        const repo = await harness.makeRepo();
        await repo.create({ id: "a1", sessionId: "s1" });
        await repo.create({ id: "b1", sessionId: "s2" });

        const stats = await repo.statsBySessions(["s1"]);
        expect([...stats.keys()]).toEqual(["s1"]);
      });

      it("空数组返回空结果,不打库", async () => {
        const repo = await harness.makeRepo();
        await repo.create({ id: "a1", sessionId: "s1" });
        expect((await repo.statsBySessions([])).size).toBe(0);
      });

      it("重复 sessionId 不会把计数翻倍", async () => {
        const repo = await harness.makeRepo();
        await repo.create({ id: "a1", sessionId: "s1" });
        await repo.create({ id: "a2", sessionId: "s1" });

        const stats = await repo.statsBySessions(["s1", "s1", "s1"]);
        expect(stats.get("s1")?.runs).toBe(2);
      });

      it("终态运行照样计入 —— 会话跑过多少轮与结局无关", async () => {
        const repo = await harness.makeRepo();
        await repo.create({ id: "a1", sessionId: "s1" });
        const c = await repo.claimNext(30_000, 1000);
        await repo.complete("a1", "failed", c?.fence);
        await repo.create({ id: "a2", sessionId: "s1" });
        await repo.cancel("a2");

        expect((await repo.statsBySessions(["s1"])).get("s1")?.runs).toBe(2);
      });

      it("lastRunAt 落在合理的时间区间内", async () => {
        const repo = await harness.makeRepo();
        const before = Date.now();
        await repo.create({ id: "a1", sessionId: "s1" });
        const after = Date.now();

        const at = (await repo.statsBySessions(["s1"])).get("s1")?.lastRunAt ?? 0;
        // MySQL 的 timestamp 只到秒,向下取整后可能略早于 before,故留 1 秒余量
        expect(at).toBeGreaterThanOrEqual(before - 1000);
        expect(at).toBeLessThanOrEqual(after + 1000);
      });
    });
  });
}
