// AgentRepo.list 的挤占回归:内存实现与真实 MySQL 跑同一套断言。
//
// 曾经的 list() 取全库最新 200 条再由路由在内存里过滤。平台上的智能体一过 200,
// 内置公开智能体就被挤出去,新用户列表为空、工作台输入框禁用。
// 这个缺陷只在总量超过上限时才显形,所以必须对真实 SQL 跑一遍。

import { randomUUID } from "node:crypto";
import { createDb } from "@/lib/db/client";
import { InMemoryAgentRepo } from "@/lib/modules/agent/adapters/in-memory-agent-repo";
import { MysqlAgentRepo } from "@/lib/modules/agent/adapters/mysql-agent-repo";
import type { AgentRepo } from "@/lib/modules/agent/ports";
import { afterAll, describe, expect, it } from "vitest";

function contract(name: string, make: () => AgentRepo) {
  describe(`AgentRepo.list 契约:${name}`, () => {
    it(
      "别人建了 210 个更新的智能体,自己的和被分享的仍然列得出来,计数准确",
      { timeout: 120_000 },
      async () => {
        const repo = make();
        const tag = randomUUID().replace(/-/g, "").slice(0, 10);
        const me = `me-${tag}`;
        const noisy = `noisy-${tag}`;
        const mk = (id: string, ownerId: string) =>
          repo.upsert({ id, ownerId, name: id, config: { systemPrompt: "p", model: "sonnet" } });

        await mk(`mine-${tag}`, me);
        await mk(`shared-${tag}`, `other-${tag}`);
        await new Promise((r) => setTimeout(r, 1100)); // MySQL timestamp 精度到秒
        for (let i = 0; i < 210; i++) await mk(`n${i}-${tag}`, noisy);

        const list = await repo.list({ ownerId: me, ids: [`shared-${tag}`] });
        expect(list.map((a) => a.id).sort()).toEqual([`mine-${tag}`, `shared-${tag}`]);

        const counts = await repo.countByOwner();
        expect(counts.get(noisy)).toBe(210);
        expect(counts.get(me)).toBe(1);

        expect(await repo.list({})).toEqual([]);
      },
    );
  });
}

contract("InMemoryAgentRepo", () => new InMemoryAgentRepo());

const TEST_DB_URL = process.env.OWA_TEST_DATABASE_URL;
if (!TEST_DB_URL) {
  console.warn(
    "[skip] AgentRepo.list 的 MySQL 契约未运行 —— 需设置 OWA_TEST_DATABASE_URL 指向测试库",
  );
} else {
  if (!/test/i.test(new URL(TEST_DB_URL).pathname)) {
    throw new Error("OWA_TEST_DATABASE_URL 的库名须含 test");
  }
  const { db, pool } = createDb(TEST_DB_URL);
  contract("MysqlAgentRepo(真实 MySQL)", () => new MysqlAgentRepo(db));
  afterAll(async () => {
    await pool.end();
  });
}
