// AuditRepo 契约:内存实现与真实 MySQL 跑同一套断言(可见性、倒序、键集分页、过滤)。
// MySQL 部分需要 OWA_TEST_DATABASE_URL,未配置时跳过并说明。每条用例用随机用户 id,不清表。

import { randomUUID } from "node:crypto";
import { createDb } from "@/lib/db/client";
import { InMemoryAuditRepo } from "@/lib/modules/audit/adapters/in-memory-audit-repo";
import { MysqlAuditRepo } from "@/lib/modules/audit/adapters/mysql-audit-repo";
import type { AuditEvent, AuditRepo } from "@/lib/modules/audit/ports";
import { afterAll, describe, expect, it } from "vitest";

function contract(name: string, make: () => AuditRepo) {
  describe(`AuditRepo 契约:${name}`, () => {
    const tag = () => randomUUID().replace(/-/g, "").slice(0, 12);
    const ev = (over: Partial<AuditEvent> & { at: number }): AuditEvent => ({
      id: randomUUID(),
      actor: { type: "user", id: "actor" },
      action: "agent.update",
      resource: { type: "agent", id: "a" },
      ...over,
    });

    it("可见性:归属人与操作者本人看得到,无关的人看不到", async () => {
      const repo = make();
      const owner = `o-${tag()}`;
      const actor = `x-${tag()}`;
      const stranger = `s-${tag()}`;
      await repo.append(ev({ at: 1, ownerId: owner, actor: { type: "user", id: actor } }));
      expect((await repo.list({ visibleTo: owner })).items).toHaveLength(1);
      expect((await repo.list({ visibleTo: actor })).items).toHaveLength(1);
      expect((await repo.list({ visibleTo: stranger })).items).toHaveLength(0);
    });

    it("同一 id 重复追加:只留第一条,不报错、不改写", async () => {
      const repo = make();
      const owner = `o-${tag()}`;
      const id = randomUUID();
      await repo.append(ev({ id, at: 10, ownerId: owner, details: { n: 1 } }));
      await repo.append(ev({ id, at: 20, ownerId: owner, details: { n: 2 } }));
      const items = (await repo.list({ visibleTo: owner })).items;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ at: 10, details: { n: 1 } });
    });

    it("按时间倒序,键集分页不重不漏(含同一毫秒的多条)", async () => {
      const repo = make();
      const owner = `o-${tag()}`;
      const ats = [100, 200, 200, 200, 300, 400, 500];
      for (const at of ats) await repo.append(ev({ at, ownerId: owner }));
      const seen: number[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10; i++) {
        const page = await repo.list({ visibleTo: owner, limit: 2, cursor });
        seen.push(...page.items.map((e) => e.at));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(seen).toEqual([...ats].sort((a, b) => b - a));
    });

    it("按动作、资源、时间范围过滤;细节原样往返", async () => {
      const repo = make();
      const owner = `o-${tag()}`;
      await repo.append(
        ev({
          at: 10,
          ownerId: owner,
          action: "agent.publish",
          resource: { type: "agent", id: "A" },
          details: { version: 3, note: "首版" },
        }),
      );
      await repo.append(
        ev({
          at: 20,
          ownerId: owner,
          action: "api_key.issue",
          resource: { type: "api_key", id: "K" },
        }),
      );
      await repo.append(
        ev({
          at: 30,
          ownerId: owner,
          action: "agent.update",
          resource: { type: "agent", id: "B" },
        }),
      );

      const pub = await repo.list({ visibleTo: owner, action: "agent.publish" });
      expect(pub.items.map((e) => e.details)).toEqual([{ version: 3, note: "首版" }]);
      const a = await repo.list({ visibleTo: owner, resourceType: "agent", resourceId: "B" });
      expect(a.items.map((e) => e.at)).toEqual([30]);
      const range = await repo.list({ visibleTo: owner, since: 15, until: 25 });
      expect(range.items.map((e) => e.action)).toEqual(["api_key.issue"]);
    });
  });
}

contract("InMemoryAuditRepo", () => new InMemoryAuditRepo());

const TEST_DB_URL = process.env.OWA_TEST_DATABASE_URL;
if (!TEST_DB_URL) {
  console.warn("[skip] AuditRepo 的 MySQL 契约未运行 —— 需设置 OWA_TEST_DATABASE_URL 指向测试库");
} else {
  if (!/test/i.test(new URL(TEST_DB_URL).pathname)) {
    throw new Error("OWA_TEST_DATABASE_URL 的库名须含 test");
  }
  const { db, pool } = createDb(TEST_DB_URL);
  contract("MysqlAuditRepo(真实 MySQL)", () => new MysqlAuditRepo(db));
  afterAll(async () => {
    await pool.end();
  });
}
