// 知识库仓储对真实 MySQL 的测试(上限调小便于撞线)。未配置 OWA_TEST_DATABASE_URL 时跳过并说明。
//
// 核心回归:曾经列表取最新 500 篇、检索取最早 500 篇,超过上限后两边各看各的。

import { randomUUID } from "node:crypto";
import { createDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { knowledgeDocs } from "@/lib/db/schema";
import { MysqlAgentRepo } from "@/lib/modules/agent/adapters/mysql-agent-repo";
import { MysqlKnowledgeRepo } from "@/lib/modules/knowledge/adapters/mysql-knowledge-repo";
import { ChunkCache } from "@/lib/modules/knowledge/application/chunk-cache";
import {
  KnowledgeLimitExceeded,
  KnowledgeWriteAborted,
} from "@/lib/modules/knowledge/domain/limits";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { afterAll, describe, expect, it } from "vitest";

const TEST_DB_URL = process.env.OWA_TEST_DATABASE_URL;

if (!TEST_DB_URL) {
  console.warn("[skip] 知识库仓储 MySQL 测试未运行 —— 需设置 OWA_TEST_DATABASE_URL 指向测试库");
  describe.skip("MysqlKnowledgeRepo(未配置测试库,已跳过)", () => {
    it("skipped", () => {});
  });
} else {
  if (!/test/i.test(new URL(TEST_DB_URL).pathname)) {
    throw new Error("OWA_TEST_DATABASE_URL 的库名须含 test");
  }
  const { db, pool } = createDb(TEST_DB_URL);
  const agents = new MysqlAgentRepo(db);
  const limits = { maxDocs: 3, maxDocChars: 50, maxTotalChars: 100 };
  const repo = new MysqlKnowledgeRepo(db, limits);
  afterAll(async () => {
    await pool.end();
  });

  async function newAgent(): Promise<string> {
    const id = `k${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    await agents.upsert({
      id,
      ownerId: "u",
      name: id,
      config: { systemPrompt: "p", model: "sonnet" },
    });
    return id;
  }
  const doc = (agentId: string, content = "内容") => ({
    id: randomUUID().replace(/-/g, "").slice(0, 24),
    agentId,
    title: "t",
    content,
  });

  describe("MysqlKnowledgeRepo(真实 MySQL)", () => {
    describe(
      "createMany 等连接池分配连接:有界,放弃后晚到的连接立刻归还",
      { timeout: 30_000 },
      () => {
        /** 只有一个连接的池,和用它的仓储 */
        function singlePool() {
          const p = mysql.createPool({ uri: TEST_DB_URL as string, connectionLimit: 1 });
          const r = new MysqlKnowledgeRepo(drizzle(p, { schema, mode: "default" }), limits, p);
          return { p, r };
        }
        const count = async (agentId: string) => (await repo.list(agentId)).docs.length;

        it("连接池占满:到期限就放弃、不写入;之后连接释放,池子照常可用(晚到的连接已归还)", async () => {
          const { p, r } = singlePool();
          try {
            const agentId = await newAgent();
            const held = await p.getConnection();
            const start = Date.now();
            await expect(
              r.createMany(agentId, [doc(agentId, "排队")], { deadline: Date.now() + 500 }),
            ).rejects.toMatchObject({ why: "timeout" });
            expect(Date.now() - start).toBeLessThan(1_000);
            // 期限过后才释放连接:排队中的那次 getConnection 会拿到它,必须立刻还回来
            await new Promise((res) => setTimeout(res, 300));
            held.release();
            await new Promise((res) => setTimeout(res, 100));
            const t = Date.now();
            await p.query("SELECT 1");
            expect(Date.now() - t).toBeLessThan(500);
            expect(await count(agentId)).toBe(0);
          } finally {
            await p.end();
          }
        });

        it("等连接期间调用方取消:放弃、不写入", async () => {
          const { p, r } = singlePool();
          try {
            const agentId = await newAgent();
            const held = await p.getConnection();
            const ac = new AbortController();
            setTimeout(() => ac.abort(), 200);
            await expect(
              r.createMany(agentId, [doc(agentId, "取消")], {
                deadline: Date.now() + 10_000,
                signal: ac.signal,
              }),
            ).rejects.toMatchObject({ why: "aborted" });
            held.release();
            await new Promise((res) => setTimeout(res, 100));
            expect(await count(agentId)).toBe(0);
          } finally {
            await p.end();
          }
        });

        it("拿到连接、进入锁等待后取消,锁一直不放:及时返回(不等 KILL),连接被终止不再占用,服务端会话随后被后台 KILL 结束;之后放锁也不落库", async () => {
          const { p, r } = singlePool();
          const lockConn = await pool.getConnection();
          try {
            const agentId = await newAgent();
            await lockConn.query("BEGIN");
            await lockConn.query("SELECT id FROM agents WHERE id = ? FOR UPDATE", [agentId]);
            // 服务端有没有这次写入的会话还停在锁上(按语句与智能体 id 找;innodb_trx 在等锁的瞬间不一定列出它)
            const waiting = async () => {
              const [rows] = await pool.query(
                "SELECT COUNT(*) AS n FROM information_schema.processlist WHERE info LIKE ?",
                [`SELECT id FROM agents WHERE id = '${agentId}' LIMIT 1 FOR UPDATE%`],
              );
              return Number((rows as { n: number }[])[0]?.n);
            };
            const ac = new AbortController();
            const writing = r.createMany(agentId, [doc(agentId, "断开")], {
              deadline: Date.now() + 50_000,
              signal: ac.signal,
            });
            // 确认它确实进入了锁等待,再取消
            for (let i = 0; i < 50 && (await waiting()) === 0; i++) {
              await new Promise((res) => setTimeout(res, 50));
            }
            expect(await waiting()).toBeGreaterThan(0);
            const start = Date.now();
            ac.abort();
            await expect(writing).rejects.toMatchObject({ why: "aborted" });
            expect(Date.now() - start).toBeLessThan(1_000);
            // 返回时 KILL 只是已发起:轮询等它生效,服务端那个等锁的会话随即被终止(不是等到 50 秒的等锁超时)
            let left = await waiting();
            for (let i = 0; i < 20 && left > 0; i++) {
              await new Promise((res) => setTimeout(res, 50));
              left = await waiting();
            }
            expect(left).toBe(0);
            // 单连接池仍可用:被终止的连接没有占着名额
            const t = Date.now();
            await p.query("SELECT 1");
            expect(Date.now() - t).toBeLessThan(1_000);
            await lockConn.query("COMMIT");
            await new Promise((res) => setTimeout(res, 200));
            expect(await count(agentId)).toBe(0);
          } finally {
            await lockConn.query("ROLLBACK").catch(() => {});
            lockConn.release();
            await p.end();
          }
        });

        it("期限在锁等待中到达、锁一直不放:按期限结束,不等到等锁超时", async () => {
          const { p, r } = singlePool();
          const lockConn = await pool.getConnection();
          try {
            const agentId = await newAgent();
            await lockConn.query("BEGIN");
            await lockConn.query("SELECT id FROM agents WHERE id = ? FOR UPDATE", [agentId]);
            const start = Date.now();
            // 期限 1.3 秒:等锁时间按整秒取到 2 秒,应按期限而不是 2 秒结束
            await expect(
              r.createMany(agentId, [doc(agentId, "到期")], { deadline: Date.now() + 1_300 }),
            ).rejects.toMatchObject({ why: "timeout" });
            expect(Date.now() - start).toBeLessThan(1_800);
            await lockConn.query("COMMIT");
            await new Promise((res) => setTimeout(res, 200));
            expect(await count(agentId)).toBe(0);
          } finally {
            await lockConn.query("ROLLBACK").catch(() => {});
            lockConn.release();
            await p.end();
          }
        });

        it("对照:没有争用时照常写入,返回的是事务内回读的完整记录", async () => {
          const { p, r } = singlePool();
          try {
            const agentId = await newAgent();
            const saved = await r.createMany(agentId, [doc(agentId, "甲"), doc(agentId, "乙")], {
              deadline: Date.now() + 5_000,
            });
            expect(saved.map((d) => d.content)).toEqual(["甲", "乙"]);
            expect(saved.every((d) => d.createdAt > 0)).toBe(true);
            expect(await count(agentId)).toBe(2);
          } finally {
            await p.end();
          }
        });
      },
    );

    describe("createMany 等智能体行锁期间被放弃:锁释放后也不写入", { timeout: 30_000 }, () => {
      /** 另一个连接占住智能体那一行的锁,ms 毫秒后提交释放 */
      async function holdLock(agentId: string, ms: number) {
        const conn = await pool.getConnection();
        await conn.query("BEGIN");
        await conn.query("SELECT id FROM agents WHERE id = ? FOR UPDATE", [agentId]);
        return new Promise<void>((resolve) => {
          setTimeout(async () => {
            await conn.query("COMMIT");
            conn.release();
            resolve();
          }, ms);
        });
      }
      const count = async (agentId: string) => (await repo.list(agentId)).docs.length;

      it("等锁期间调用方取消:锁释放后回滚,一篇都不写", async () => {
        const agentId = await newAgent();
        const held = holdLock(agentId, 1_200);
        await new Promise((r) => setTimeout(r, 50));
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 300);
        const writing = repo.createMany(agentId, [doc(agentId, "取消")], {
          deadline: Date.now() + 10_000,
          signal: ac.signal,
        });
        await expect(writing).rejects.toMatchObject({ why: "aborted" });
        await held;
        expect(await count(agentId)).toBe(0);
      });

      it("等锁超过期限:MySQL 等锁超时、回滚,一篇都不写;锁之后才释放", async () => {
        const agentId = await newAgent();
        const held = holdLock(agentId, 3_000);
        await new Promise((r) => setTimeout(r, 50));
        const start = Date.now();
        const writing = repo.createMany(agentId, [doc(agentId, "超时")], {
          deadline: Date.now() + 800,
        });
        await expect(writing).rejects.toBeInstanceOf(KnowledgeWriteAborted);
        // 等锁时间被限制在剩余时间内(整秒向上取整),不是默认的 50 秒
        expect(Date.now() - start).toBeLessThan(2_500);
        await held;
        expect(await count(agentId)).toBe(0);
      });

      it("等锁期间到点、但锁在等锁超时前释放:拿到锁后复查期限,回滚不写", async () => {
        const agentId = await newAgent();
        // 期限 400ms,等锁时间按整秒取到 1 秒;锁在 700ms 释放 —— 拿到锁时已经过了期限
        const held = holdLock(agentId, 700);
        await new Promise((r) => setTimeout(r, 50));
        const writing = repo.createMany(agentId, [doc(agentId, "过期")], {
          deadline: Date.now() + 400,
        });
        await expect(writing).rejects.toMatchObject({ why: "timeout" });
        await held;
        expect(await count(agentId)).toBe(0);
      });

      it("对照:没取消、没到期,锁释放后照常写入;会话的等锁超时恢复原值", async () => {
        const agentId = await newAgent();
        const held = holdLock(agentId, 300);
        await new Promise((r) => setTimeout(r, 50));
        const saved = await repo.createMany(agentId, [doc(agentId, "照常")], {
          deadline: Date.now() + 10_000,
          signal: new AbortController().signal,
        });
        await held;
        expect(saved).toHaveLength(1);
        expect(await count(agentId)).toBe(1);
      });

      it("写入后连接上的等锁超时恢复原值(连接会被别的查询复用)", async () => {
        // 只有一个连接的池:检查的就是刚才执行写入的那个连接
        const single = mysql.createPool({ uri: TEST_DB_URL as string, connectionLimit: 1 });
        try {
          const singleRepo = new MysqlKnowledgeRepo(
            drizzle(single, { schema, mode: "default" }),
            limits,
          );
          const [before] = await single.query("SELECT @@SESSION.innodb_lock_wait_timeout AS v");
          const agentId = await newAgent();
          await singleRepo.createMany(agentId, [doc(agentId, "一")], {
            deadline: Date.now() + 2_000,
          });
          await expect(
            singleRepo.createMany(agentId, [doc(agentId, "x".repeat(60))], {
              deadline: Date.now() + 2_000,
            }),
          ).rejects.toBeInstanceOf(KnowledgeLimitExceeded);
          const [after] = await single.query("SELECT @@SESSION.innodb_lock_wait_timeout AS v");
          expect((after as { v: number }[])[0]?.v).toBe((before as { v: number }[])[0]?.v);
        } finally {
          await single.end();
        }
      });
    });

    it("createMany:一个文件切成的几篇要么都进、要么都不进,上限按合计判定", async () => {
      const agentId = await newAgent();
      await repo.create(doc(agentId, "x".repeat(40)));
      // 再加 3 篇会超 3 篇上限:一篇都不进
      await expect(
        repo.createMany(agentId, [doc(agentId, "a"), doc(agentId, "b"), doc(agentId, "c")]),
      ).rejects.toBeInstanceOf(KnowledgeLimitExceeded);
      expect((await repo.list(agentId)).docs).toHaveLength(1);
      // 合计字数超 100:一篇都不进
      await expect(
        repo.createMany(agentId, [doc(agentId, "y".repeat(40)), doc(agentId, "z".repeat(30))]),
      ).rejects.toBeInstanceOf(KnowledgeLimitExceeded);
      expect((await repo.list(agentId)).docs).toHaveLength(1);
      // 两篇、合计 60 字:都进
      const saved = await repo.createMany(agentId, [
        doc(agentId, "y".repeat(30)),
        doc(agentId, "z".repeat(30)),
      ]);
      expect(saved).toHaveLength(2);
      expect((await repo.list(agentId)).docs).toHaveLength(3);
    });

    it("超额旧数据:列表标出的可检索集合与检索实际取到的完全一致(含同一秒写入的文档)", async () => {
      const agentId = await newAgent();
      // 绕过上限直接写入 5 篇,模拟上限设立之前的数据;同一秒写入,只按时间排序是不确定的
      const ids = Array.from({ length: 5 }, () => randomUUID().replace(/-/g, "").slice(0, 24));
      for (const id of ids) {
        await db.insert(knowledgeDocs).values({ id, agentId, title: id, content: `正文 ${id}` });
      }
      const listing = await repo.list(agentId);
      expect(listing.docs).toHaveLength(5); // 不截断
      expect(listing.usage.docs).toBe(5);
      const searchable = listing.docs
        .filter((d) => d.searchable)
        .map((d) => d.id)
        .sort();
      expect(searchable).toHaveLength(3);
      const retrieved = [...new Set((await repo.chunksOf(agentId)).map((c) => c.docId))].sort();
      expect(retrieved).toEqual(searchable);
    });

    it("写入时拦住超限:篇数、总字数、单篇长度", async () => {
      const a1 = await newAgent();
      for (let i = 0; i < 3; i++) await repo.create(doc(a1));
      await expect(repo.create(doc(a1))).rejects.toBeInstanceOf(KnowledgeLimitExceeded);

      const a2 = await newAgent();
      await repo.create(doc(a2, "字".repeat(50)));
      await repo.create(doc(a2, "字".repeat(45)));
      await expect(repo.create(doc(a2, "字".repeat(10)))).rejects.toThrow(/合计/);

      const a3 = await newAgent();
      await expect(repo.create(doc(a3, "字".repeat(51)))).rejects.toThrow(/单篇/);
      expect((await repo.list(a3)).usage.docs).toBe(0);
    });

    it("并发上传:恰好上限那么多篇成功,其余被拒", { timeout: 30_000 }, async () => {
      const agentId = await newAgent();
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => repo.create(doc(agentId))),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
      for (const r of results) {
        if (r.status === "rejected") expect(r.reason).toBeInstanceOf(KnowledgeLimitExceeded);
      }
      expect((await repo.list(agentId)).usage.docs).toBe(3);
    });

    it("update 事务:并发扩充撞限,恰好一个成功一个被拒", { timeout: 30_000 }, async () => {
      const agentId = await newAgent();
      // 三篇各 30 字 = 90 字 (上限 100)
      const d1 = await repo.create(doc(agentId, "字".repeat(30)));
      const d2 = await repo.create(doc(agentId, "字".repeat(30)));
      await repo.create(doc(agentId, "字".repeat(30)));
      // 两篇同时改到 36 字: 第一个 90-30+36=96≤100 成功, 第二个 96-30+36=102>100 被拒
      const results = await Promise.allSettled([
        repo.update(d1.id, { content: "字".repeat(36) }),
        repo.update(d2.id, { content: "字".repeat(36) }),
      ]);
      const ok = results.filter((r) => r.status === "fulfilled");
      const fail = results.filter((r) => r.status === "rejected");
      expect(ok).toHaveLength(1);
      expect(fail).toHaveLength(1);
      expect((fail[0] as PromiseRejectedResult).reason).toBeInstanceOf(KnowledgeLimitExceeded);
      const listing = await repo.list(agentId);
      expect(listing.usage.chars).toBeLessThanOrEqual(limits.maxTotalChars);
    });

    it("update 后 signatureOf 变化、缓存失效", async () => {
      const agentId = await newAgent();
      const d = await repo.create(doc(agentId, "二叉树的遍历方式"));
      const cache1 = new ChunkCache(repo);
      const cache2 = new ChunkCache(repo);

      const chunks1a = await cache1.chunksOf(agentId);
      const chunks1b = await cache2.chunksOf(agentId);
      expect(chunks1a.some((c) => c.text.includes("二叉树"))).toBe(true);
      expect(chunks1b.some((c) => c.text.includes("二叉树"))).toBe(true);

      const sigBefore = await repo.signatureOf(agentId);
      await repo.update(d.id, { content: "哈希表的实现原理" });
      const sigAfter = await repo.signatureOf(agentId);
      expect(sigAfter).not.toBe(sigBefore);

      const chunks2a = await cache1.chunksOf(agentId);
      const chunks2b = await cache2.chunksOf(agentId);
      expect(chunks2a.some((c) => c.text.includes("哈希表"))).toBe(true);
      expect(chunks2a.some((c) => c.text.includes("二叉树"))).toBe(false);
      expect(chunks2b.some((c) => c.text.includes("哈希表"))).toBe(true);
    });

    it("update 后编辑标题:缓存读到新标题", async () => {
      const agentId = await newAgent();
      const d = await repo.create(doc(agentId, "内容不变"));
      const cache = new ChunkCache(repo);

      const before = await cache.chunksOf(agentId);
      expect(before[0]?.docTitle).toBe("t");

      await repo.update(d.id, { title: "新标题" });
      const after = await cache.chunksOf(agentId);
      expect(after[0]?.docTitle).toBe("新标题");
    });

    it("update 返回值是更新后的数据,不是旧数据", async () => {
      const agentId = await newAgent();
      const d = await repo.create(doc(agentId, "旧正文"));
      const result = await repo.update(d.id, { title: "新标题", content: "新正文" });
      expect(result).not.toBeNull();
      expect(result?.title).toBe("新标题");
      expect(result?.content).toBe("新正文");
    });
  });
}
