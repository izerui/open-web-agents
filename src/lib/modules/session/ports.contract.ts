// SessionRepo 的可替换性契约:内存实现与 MySQL 实现跑同一套断言。
//
// 重点在 list 的【归属过滤】。这条曾经是个静默失效:list() 无参取全局最新 100 条,
// 路由拿到之后才按归属过滤。于是只要别的租户新建了 100 个会话,用户打开自己的列表
// 就是空的 —— 数据没丢,但界面完全不可达,能看到几条取决于【别人】的活跃度,
// 而且没有游标、没有截断提示。
//
// 这个缺陷只在「总量超过上限」时才显形,所以必须对真实 SQL 跑一遍:
// 内存实现没有 100 条上限,单测它永远发现不了。

import type { SessionRepo } from "@/lib/modules/session/ports";
import { beforeEach, describe, expect, it } from "vitest";

export interface SessionRepoHarness {
  makeRepo(): Promise<SessionRepo>;
  /** 该实现的 list 上限;内存实现无上限则传 undefined。 */
  listLimit?: number;
}

export function sessionRepoContract(name: string, harness: SessionRepoHarness): void {
  describe(`SessionRepo 契约:${name}`, () => {
    let repo: SessionRepo;

    beforeEach(async () => {
      repo = await harness.makeRepo();
    });

    const mk = (id: string, over: Partial<{ ownerId: string; callerApiKeyId: string }> = {}) =>
      repo.create({ id, assistantId: "a1", workspaceDir: `/ws/${id}`, ...over });

    it("按 ownerId 过滤只回该用户的会话", async () => {
      await mk("s1", { ownerId: "u1" });
      await mk("s2", { ownerId: "u2" });
      await mk("s3", { ownerId: "u1" });

      const mine = await repo.list({ ownerId: "u1" });
      expect(mine.map((s) => s.id).sort()).toEqual(["s1", "s3"]);
    });

    it("按 callerApiKeyId 过滤只回该 key 发起的会话", async () => {
      await mk("k1", { callerApiKeyId: "key-a" });
      await mk("k2", { callerApiKeyId: "key-b" });

      const list = await repo.list({ callerApiKeyId: "key-a" });
      expect(list.map((s) => s.id)).toEqual(["k1"]);
    });

    it("不传过滤条件时回全部(admin 需要看到无归属的历史数据)", async () => {
      await mk("s1", { ownerId: "u1" });
      await mk("s2");
      expect((await repo.list()).length).toBe(2);
    });

    it("按创建时间倒序", async () => {
      await mk("old", { ownerId: "u1" });
      await new Promise((r) => setTimeout(r, 1100)); // MySQL timestamp 精度到秒
      await mk("new", { ownerId: "u1" });
      expect((await repo.list({ ownerId: "u1" })).map((s) => s.id)).toEqual(["new", "old"]);
    });

    // 核心回归:过滤必须发生在截断【之前】
    const limit = harness.listLimit;
    if (limit) {
      it(
        `【挤占回归】别人建了 ${limit} 个更新的会话,自己的仍然看得到`,
        { timeout: 60_000 },
        async () => {
          await mk("mine", { ownerId: "victim" });
          await new Promise((r) => setTimeout(r, 1100));
          // 其他租户刷满一整页
          for (let i = 0; i < limit; i++) {
            await mk(`other-${i}`, { ownerId: "noisy-neighbor" });
          }

          const mine = await repo.list({ ownerId: "victim" });
          // 曾经这里是 [] —— 数据还在,界面却完全够不着
          expect(mine.map((s) => s.id)).toEqual(["mine"]);
        },
      );
    }
  });
}
