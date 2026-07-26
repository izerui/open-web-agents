import { InMemoryRunRepo } from "@/lib/modules/run/adapters/in-memory-run-repo";
import { describe, expect, it } from "vitest";

describe("InMemoryRunRepo", () => {
  it("认领 pending 并置租约", async () => {
    const repo = new InMemoryRunRepo();
    await repo.create({ id: "r1", sessionId: "s1" });
    const claimed = await repo.claimNext(1000, 100);
    expect(claimed?.id).toBe("r1");
    expect(claimed?.state).toBe("running");
    expect(claimed?.leaseUntil).toBe(1100);
  });

  it("租约未过期时不重复认领", async () => {
    const repo = new InMemoryRunRepo();
    await repo.create({ id: "r1", sessionId: "s1" });
    await repo.claimNext(1000, 100);
    expect(await repo.claimNext(1000, 500)).toBeNull();
  });

  it("租约过期后可被重新认领(worker 崩溃兜底)", async () => {
    const repo = new InMemoryRunRepo();
    await repo.create({ id: "r1", sessionId: "s1" });
    await repo.claimNext(1000, 100);
    const reclaimed = await repo.claimNext(1000, 2000);
    expect(reclaimed?.id).toBe("r1");
  });

  it("touch 续租可阻止被抢", async () => {
    const repo = new InMemoryRunRepo();
    await repo.create({ id: "r1", sessionId: "s1" });
    await repo.claimNext(1000, 100);
    await repo.touch("r1", 5000);
    expect(await repo.claimNext(1000, 2000)).toBeNull();
  });

  it("reclaimOrphans 把过期 running 打回 pending", async () => {
    const repo = new InMemoryRunRepo();
    await repo.create({ id: "r1", sessionId: "s1" });
    await repo.claimNext(1000, 100);
    expect(await repo.reclaimOrphans(2000)).toBe(1);
    expect((await repo.get("r1"))?.state).toBe("pending");
  });

  it("reclaimOrphans 不动租约内的 running", async () => {
    const repo = new InMemoryRunRepo();
    await repo.create({ id: "r1", sessionId: "s1" });
    await repo.claimNext(1000, 100);
    expect(await repo.reclaimOrphans(500)).toBe(0);
  });

  it("complete 后清租约、不再被认领", async () => {
    const repo = new InMemoryRunRepo();
    await repo.create({ id: "r1", sessionId: "s1" });
    await repo.claimNext(1000, 100);
    await repo.complete("r1", "success");
    const run = await repo.get("r1");
    expect(run?.state).toBe("success");
    expect(run?.leaseUntil).toBeNull();
    expect(await repo.claimNext(1000, 9999)).toBeNull();
  });

  it("get 不存在的 run 返回 null", async () => {
    expect(await new InMemoryRunRepo().get("nope")).toBeNull();
  });
});
