// AgentVersionRepo 的可替换性契约:内存实现与 MySQL 实现跑同一套断言。
//
// 重点在两处只有真实数据库才暴露的问题:
// 1. 并发发布 —— 版本号分配与指针移动若不在一把锁里,两个人同时点发布会拿到同一个号,
//    或者指针指向了别人那一版;
// 2. 重复激活同一版本 —— MySQL 的 affectedRows 默认只数"真的改了"的行,
//    指针已经是它时更新 0 行,若据此判"版本不存在"就会误报。

import { randomUUID } from "node:crypto";
import type { AgentRepo, AgentVersionRepo } from "@/lib/modules/agent/ports";
import { beforeEach, describe, expect, it } from "vitest";

export interface AgentVersionHarness {
  make(): Promise<{ agents: AgentRepo; versions: AgentVersionRepo }>;
}

export function agentVersionRepoContract(name: string, harness: AgentVersionHarness): void {
  describe(`AgentVersionRepo 契约:${name}`, () => {
    let agents: AgentRepo;
    let versions: AgentVersionRepo;
    let id: string;

    beforeEach(async () => {
      ({ agents, versions } = await harness.make());
      id = `t${randomUUID().replace(/-/g, "").slice(0, 20)}`;
      await agents.upsert({
        id,
        ownerId: "u1",
        name: "draft",
        config: {
          systemPrompt: "v1",
          model: "sonnet",
          inputSchema: { type: "object", properties: { a: { type: "string" } } },
        },
      });
    });

    const snap = (prompt: string) => ({
      name: `n-${prompt}`,
      config: {
        systemPrompt: prompt,
        model: "sonnet" as const,
        inputSchema: { type: "object", properties: { a: { type: "string" } } },
      },
    });

    it("发布:版本号从 1 递增,指针随之移动,快照原样可取", async () => {
      const v1 = await versions.publish(id, snap("p1"), { contentHash: "h1", createdBy: "u1" });
      const v2 = await versions.publish(id, snap("p2"), {
        contentHash: "h2",
        createdBy: "u2",
        note: "改了提示词",
      });
      expect([v1.version, v2.version]).toEqual([1, 2]);
      const a = await agents.get(id);
      expect(a?.publishedVersion).toBe(2);
      expect(a?.publishedHash).toBe("h2");
      expect((await versions.get(id, 1))?.config).toEqual(snap("p1").config);
      const list = await versions.list(id);
      expect(list.map((v) => v.version)).toEqual([2, 1]);
      expect(list[0]).not.toHaveProperty("config");
      expect(list[0]?.note).toBe("改了提示词");
    });

    it("改草稿(upsert)不移动发布指针", async () => {
      await versions.publish(id, snap("p1"), { contentHash: "h1", createdBy: "u1" });
      const a = await agents.get(id);
      if (!a) throw new Error("missing");
      await agents.upsert({ ...a, config: { systemPrompt: "draft-2", model: "sonnet" } });
      const after = await agents.get(id);
      expect(after?.publishedVersion).toBe(1);
      expect(after?.publishedHash).toBe("h1");
    });

    it("回滚:指针指回旧版本;重复激活同一版本不报错;不存在的版本报错", async () => {
      await versions.publish(id, snap("p1"), { contentHash: "h1", createdBy: "u1" });
      await versions.publish(id, snap("p2"), { contentHash: "h2", createdBy: "u1" });
      await versions.activate(id, 1, "h1");
      await versions.activate(id, 1, "h1");
      expect((await agents.get(id))?.publishedVersion).toBe(1);
      await expect(versions.activate(id, 7, "x")).rejects.toThrow();
      expect((await agents.get(id))?.publishedVersion).toBe(1);
    });

    it("并发发布:版本号不重复,指针指向最大的那一版", { timeout: 30_000 }, async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          versions.publish(id, snap(`c${i}`), { contentHash: `h${i}`, createdBy: "u1" }),
        ),
      );
      const nums = results.map((v) => v.version).sort((a, b) => a - b);
      expect(nums).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      const a = await agents.get(id);
      expect(a?.publishedVersion).toBe(8);
      const top = results.find((v) => v.version === 8);
      expect(a?.publishedHash).toBe(top?.contentHash);
    });

    it("getMany 一次取回多个版本", async () => {
      await versions.publish(id, snap("p1"), { contentHash: "h1", createdBy: "u1" });
      await versions.publish(id, snap("p2"), { contentHash: "h2", createdBy: "u1" });
      const got = await versions.getMany([
        { agentId: id, version: 2 },
        { agentId: id, version: 1 },
        { agentId: id, version: 9 },
      ]);
      expect(got.map((v) => v.version).sort()).toEqual([1, 2]);
      expect(await versions.getMany([])).toEqual([]);
    });
  });
}
