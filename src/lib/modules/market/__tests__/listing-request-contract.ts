import { beforeEach, describe, expect, it } from "vitest";
import type { ListingRequestRepo } from "../listing-request-ports";

/**
 * 内存与 MySQL 两个实现共用的契约。
 * id 带上每次运行的前缀:真实库里重复跑、或库里本来就有别的申请时,用例互不干扰。
 */
export function listingRequestContract(
  name: string,
  make: () => ListingRequestRepo | Promise<ListingRequestRepo>,
  prefix: string,
) {
  describe(name, () => {
    let repo: ListingRequestRepo;
    let n = 0;
    beforeEach(async () => {
      repo = await make();
      n++;
    });
    const id = (x: string) => `${prefix}${n}${x}`;
    const row = (rid: string, agent = "a", createdAt = 1) => ({
      id: id(rid),
      agentId: id(agent),
      version: 1,
      requesterId: "u",
      createdAt,
    });
    const mine = (ids: string[]) => ids.filter((x) => x.startsWith(`${prefix}${n}`));

    it("同一智能体同时只能有一条 pending;处理后可以再申请", async () => {
      expect(await repo.create(row("r1"))).toMatchObject({ id: id("r1"), status: "pending" });
      expect(await repo.create(row("r2"))).toBeNull();
      expect(await repo.create(row("r3", "b"))).not.toBeNull();
      await repo.decide(id("r1"), {
        status: "rejected",
        reason: "说明不清",
        decidedBy: "admin",
        decidedAt: 5,
      });
      expect(await repo.create(row("r4", "a", 9))).toMatchObject({ status: "pending" });
    });

    it("latestFor 取最新一条;list 按状态筛、新的在前", async () => {
      await repo.create({ ...row("r1", "a", 1), note: "给财务部用" });
      await repo.decide(id("r1"), {
        status: "approved",
        category: "research",
        decidedBy: "x",
        decidedAt: 2,
      });
      await repo.create(row("r2", "a", 3));
      await repo.create(row("r3", "b", 4));
      expect((await repo.latestFor(id("a")))?.id).toBe(id("r2"));
      expect(await repo.latestFor(id("none"))).toBeNull();
      const all = mine((await repo.list({ limit: 500 })).map((r) => r.id));
      expect(all).toEqual([id("r3"), id("r2"), id("r1")]);
      const pending = mine((await repo.list({ status: "pending", limit: 500 })).map((r) => r.id));
      expect(pending).toEqual([id("r3"), id("r2")]);
      expect(await repo.get(id("r1"))).toEqual({
        id: id("r1"),
        agentId: id("a"),
        version: 1,
        requesterId: "u",
        note: "给财务部用",
        status: "approved",
        category: "research",
        createdAt: 1,
        decidedAt: 2,
        decidedBy: "x",
      });
    });

    it("申请类别原样往返;处理后保留,通过时的类别另记", async () => {
      await repo.create({ ...row("r1"), requestedCategory: "content" });
      await repo.create(row("r2", "b"));
      expect((await repo.get(id("r1")))?.requestedCategory).toBe("content");
      expect(await repo.get(id("r2"))).not.toHaveProperty("requestedCategory");
      const done = await repo.decide(id("r1"), {
        status: "approved",
        category: "research",
        decidedBy: "x",
        decidedAt: 2,
      });
      expect(done).toMatchObject({ requestedCategory: "content", category: "research" });
      expect((await repo.latestFor(id("a")))?.requestedCategory).toBe("content");
    });

    it("decide 只对 pending 生效:第二次处理返回 null,结果不被覆盖", async () => {
      await repo.create(row("r1"));
      expect(
        await repo.decide(id("r1"), {
          status: "approved",
          category: "general",
          decidedBy: "a",
          decidedAt: 2,
        }),
      ).toMatchObject({ status: "approved" });
      expect(
        await repo.decide(id("r1"), {
          status: "rejected",
          reason: "x",
          decidedBy: "b",
          decidedAt: 3,
        }),
      ).toBeNull();
      expect(await repo.get(id("r1"))).toMatchObject({ status: "approved", decidedBy: "a" });
      expect(
        await repo.decide(id("missing"), { status: "rejected", decidedBy: "a", decidedAt: 1 }),
      ).toBeNull();
    });
  });
}
