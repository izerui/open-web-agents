// 内置智能体的种子摘要在真实 MySQL 上:写入后读回的内容不会因为存取规整(空值、JSON 键序、
// 契约字段拆列)被误判成"有人改过"—— 否则没人动过的内置智能体也永远拿不到升级。

import { randomUUID } from "node:crypto";
import { createDb } from "@/lib/db/client";
import { agents as agentsTable } from "@/lib/db/schema";
import { MysqlAgentRepo } from "@/lib/modules/agent/adapters/mysql-agent-repo";
import { seedBuiltin } from "@/lib/modules/agent/application/seed-builtin";
import type { Agent } from "@/lib/modules/agent/ports";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

const TEST_DB_URL = process.env.OWA_TEST_DATABASE_URL;

if (!TEST_DB_URL) {
  console.warn("[skip] 内置智能体种子的 MySQL 测试未运行 —— 需设置 OWA_TEST_DATABASE_URL");
  describe.skip("内置智能体种子(未配置测试库,已跳过)", () => {
    it("skipped", () => {});
  });
} else {
  if (!/test/i.test(new URL(TEST_DB_URL).pathname)) {
    throw new Error("OWA_TEST_DATABASE_URL 的库名须含 test");
  }
  const { db, pool } = createDb(TEST_DB_URL);
  const repo = new MysqlAgentRepo(db);
  const ids: string[] = [];
  afterAll(async () => {
    for (const id of ids) await db.delete(agentsTable).where(eq(agentsTable.id, id));
    await pool.end();
  });

  const deps = { agents: repo, grantPublicRead: async () => {}, warn: () => {} };

  describe("内置智能体种子(真实 MySQL)", () => {
    it("没人改过:代码里的定义更新后能升级;管理员改过:保留", async () => {
      const id = `builtin-${randomUUID().slice(0, 8)}`;
      ids.push(id);
      // 定义里带契约、可选字段缺省 —— 正是存取规整最可能出差异的形状
      const v1: Agent = {
        id,
        ownerId: "system",
        name: "内置",
        config: {
          systemPrompt: "v1",
          model: "sonnet",
          inputSchema: {
            type: "object",
            properties: { b: { type: "string" }, a: { type: "number" } },
          },
          outputSchema: { type: "object", properties: { verdict: { type: "string" } } },
        },
      };
      const v2: Agent = { ...v1, config: { ...v1.config, systemPrompt: "v2" } };

      expect(await seedBuiltin(deps, v1)).toBe("insert");
      expect(await seedBuiltin(deps, v2)).toBe("upgrade");
      expect((await repo.get(id))?.config.systemPrompt).toBe("v2");

      const cur = await repo.get(id);
      if (!cur) throw new Error("missing");
      await repo.upsert({ ...cur, config: { ...cur.config, systemPrompt: "管理员改的" } });
      expect(await seedBuiltin(deps, { ...v2, config: { ...v2.config, systemPrompt: "v3" } })).toBe(
        "keep-modified",
      );
      expect((await repo.get(id))?.config.systemPrompt).toBe("管理员改的");
    });
  });
}
