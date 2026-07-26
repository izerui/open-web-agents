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
  });
}
