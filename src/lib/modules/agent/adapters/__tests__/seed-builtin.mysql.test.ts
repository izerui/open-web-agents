// 内置智能体的种子摘要在真实 MySQL 上:写入后读回的内容不会因为存取规整(空值、JSON 键序、
// 契约字段拆列)被误判成"有人改过"—— 否则没人动过的内置智能体也永远拿不到升级。

import { randomUUID } from "node:crypto";
import { createDb } from "@/lib/db/client";
import { accessGrants, agents as agentsTable } from "@/lib/db/schema";
import { MysqlGrantRepo } from "@/lib/modules/access/adapters/mysql-grant-repo";
import { PUBLIC_PRINCIPAL } from "@/lib/modules/access/domain/grants";
import type { NewGrant } from "@/lib/modules/access/ports";
import { MysqlAgentRepo } from "@/lib/modules/agent/adapters/mysql-agent-repo";
import { seedBuiltin } from "@/lib/modules/agent/application/seed-builtin";
import type { Agent } from "@/lib/modules/agent/ports";
import { mysqlSeedInRowLock } from "@/lib/seed-in-row-lock";
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
  const grantRepo = new MysqlGrantRepo(db);
  const ids: string[] = [];
  afterAll(async () => {
    for (const id of ids) {
      await db.delete(agentsTable).where(eq(agentsTable.id, id));
      await db.delete(accessGrants).where(eq(accessGrants.resourceId, id));
    }
    await db.delete(accessGrants).where(eq(accessGrants.resourceId, "seed-test-blocker"));
    await pool.end();
  });

  // 与组装根(container.ts)同一套接线:智能体行与公开授权走同一个事务
  const publicGrant = (id: string, grantId = `grant-${id}`): NewGrant => ({
    id: grantId,
    resourceType: "agent",
    resourceId: id,
    principalType: "*",
    principalId: PUBLIC_PRINCIPAL,
    permission: "read",
  });
  const depsFor = (id: string, grantId?: string) => ({
    inRowLock: mysqlSeedInRowLock(db, publicGrant(id, grantId)),
    warn: () => {},
  });
  const publicGrantsOf = async (id: string) =>
    (await grantRepo.listForResource("agent", id)).filter(
      (g) => g.principalType === "*" && g.principalId === PUBLIC_PRINCIPAL,
    );

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

      expect(await seedBuiltin(depsFor(id), v1)).toBe("insert");
      expect(await seedBuiltin(depsFor(id), v2)).toBe("upgrade");
      expect((await repo.get(id))?.config.systemPrompt).toBe("v2");

      const cur = await repo.get(id);
      if (!cur) throw new Error("missing");
      await repo.upsert({ ...cur, config: { ...cur.config, systemPrompt: "管理员改的" } });
      expect(
        await seedBuiltin(depsFor(id), { ...v2, config: { ...v2.config, systemPrompt: "v3" } }),
      ).toBe("keep-modified");
      expect((await repo.get(id))?.config.systemPrompt).toBe("管理员改的");
    });

    it("旧数据(没有种子摘要):内容等于当前定义 → 只开始跟踪;管理员改过 → 原样保留", async () => {
      const def = (id: string): Agent => ({
        id,
        ownerId: "system",
        name: "内置",
        config: {
          systemPrompt: "当前定义",
          model: "sonnet",
          outputSchema: { type: "object", properties: { v: { type: "string" } } },
        },
      });
      // 修复前写进去的行:只有内容,没有种子摘要
      const same = `builtin-legacy-${randomUUID().slice(0, 8)}`;
      const edited = `builtin-legacy-${randomUUID().slice(0, 8)}`;
      ids.push(same, edited);
      await repo.upsert(def(same));
      await repo.upsert({
        ...def(edited),
        config: { ...def(edited).config, systemPrompt: "管理员改的" },
      });

      // 存取规整(空值、契约拆列、JSON 键序)不能让"内容等于定义"判成不等
      expect(await seedBuiltin(depsFor(same), def(same))).toBe("adopt");
      expect((await repo.get(same))?.seedHash).toBeTruthy();
      expect(
        await seedBuiltin(depsFor(same), {
          ...def(same),
          config: { ...def(same).config, systemPrompt: "新定义" },
        }),
      ).toBe("upgrade");

      expect(await seedBuiltin(depsFor(edited), def(edited))).toBe("keep-unknown");
      expect((await repo.get(edited))?.config.systemPrompt).toBe("管理员改的");
    });

    describe("首次创建与公开授权在同一个事务里", () => {
      const def = (id: string, prompt = "v1"): Agent => ({
        id,
        ownerId: "system",
        name: "内置",
        config: { systemPrompt: prompt, model: "sonnet" },
      });

      it("授权写入失败:首次初始化整体回滚(不留智能体、不留摘要);再次启动完成创建和授权", async () => {
        const id = `builtin-grant-${randomUUID().slice(0, 8)}`;
        const grantId = `grant-blocked-${randomUUID().slice(0, 8)}`;
        ids.push(id);
        // 让授权写入在数据库层真实失败:同 id 的授权已被别的资源占用 → 主键冲突
        await grantRepo.grant(publicGrant("seed-test-blocker", grantId));

        await expect(seedBuiltin(depsFor(id, grantId), def(id))).rejects.toThrow();
        expect(await repo.get(id)).toBeNull();
        expect(await repo.idTaken(id)).toBe(false); // 连行都没有 —— 智能体与摘要一起回滚了
        expect(await publicGrantsOf(id)).toEqual([]);

        // 障碍消失后再启动:仍判为首次写入,创建和授权一起完成
        await grantRepo.revoke(grantId);
        expect(await seedBuiltin(depsFor(id, grantId), def(id))).toBe("insert");
        expect((await repo.get(id))?.seedHash).toBeTruthy();
        expect(await publicGrantsOf(id)).toHaveLength(1);
      });

      it("初始化成功后管理员撤掉公开授权:之后的启动不会加回来", async () => {
        const id = `builtin-revoke-${randomUUID().slice(0, 8)}`;
        ids.push(id);
        expect(await seedBuiltin(depsFor(id), def(id))).toBe("insert");
        const [g] = await publicGrantsOf(id);
        if (!g) throw new Error("首次初始化应授予公开只读");
        await grantRepo.revoke(g.id);

        expect(await seedBuiltin(depsFor(id), def(id, "v2"))).toBe("upgrade");
        expect(await seedBuiltin(depsFor(id), def(id, "v2"))).toBe("upgrade");
        expect(await publicGrantsOf(id)).toEqual([]);
      });
    });

    describe("播种与管理员保存并发:行锁让两者串行,管理员的修改不丢", () => {
      const gate = () => {
        let open!: () => void;
        const opened = new Promise<void>((r) => {
          open = r;
        });
        return { open, opened };
      };

      for (const point of ["decided", "written"] as const) {
        it(`播种停在「${point === "decided" ? "判定之后" : "写入定义之后、读回之前"}」时管理员保存:保存等播种提交后才落库,最终保留;再启动也不覆盖`, async () => {
          const id = `builtin-race-${point}-${randomUUID().slice(0, 6)}`;
          ids.push(id);
          const v1: Agent = {
            id,
            ownerId: "system",
            name: "内置",
            config: { systemPrompt: "v1", model: "sonnet" },
          };
          const v2: Agent = { ...v1, config: { ...v1.config, systemPrompt: "v2" } };
          expect(await seedBuiltin(depsFor(id), v1)).toBe("insert");
          // 管理员打开了编辑页(拿到的是 v1)
          const seen = await repo.get(id);
          if (!seen) throw new Error("missing");

          const reached = gate();
          const release = gate();
          const seeding = seedBuiltin(
            {
              ...depsFor(id),
              pauseAt: async (p) => {
                if (p !== point) return;
                reached.open();
                await release.opened;
              },
            },
            v2,
          );
          await reached.opened;

          // 播种还在事务里:管理员保存(另一条连接)
          const admin = new MysqlAgentRepo(db);
          let saved = false;
          const saving = admin
            .upsert({ ...seen, config: { ...seen.config, systemPrompt: "管理员改的" } })
            .then(() => {
              saved = true;
            });
          await new Promise((ok) => setTimeout(ok, 400));
          expect(saved).toBe(false); // 被行锁挡着,等播种提交

          release.open();
          expect(await seeding).toBe("upgrade");
          await saving;
          expect((await repo.get(id))?.config.systemPrompt).toBe("管理员改的");

          // 再启动一次(代码里的定义又更新了):判为改过,保留
          const v3: Agent = { ...v1, config: { ...v1.config, systemPrompt: "v3" } };
          expect(await seedBuiltin(depsFor(id), v3)).toBe("keep-modified");
          expect((await repo.get(id))?.config.systemPrompt).toBe("管理员改的");
        });
      }
    });
  });
}
