// 工作目录的会话级互斥协议,对真实 MySQL + 真实文件系统。未配置 OWA_TEST_DATABASE_URL 时跳过。
//
// 核心回归:GC 判定之后、改名之前,新运行启动并写文件 —— 运行的目录与文件不能被删。

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDb } from "@/lib/db/client";
import { WorkspaceGc } from "@/lib/modules/artifacts/application/gc";
import { MysqlRunRepo } from "@/lib/modules/run/adapters/mysql-run-repo";
import { MysqlSessionRepo } from "@/lib/modules/session/adapters/mysql-session-repo";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const TEST_DB_URL = process.env.OWA_TEST_DATABASE_URL;
const DAY = 24 * 60 * 60_000;

if (!TEST_DB_URL) {
  console.warn("[skip] 工作目录互斥协议的 MySQL 测试未运行 —— 需设置 OWA_TEST_DATABASE_URL");
  describe.skip("工作目录互斥协议(未配置测试库,已跳过)", () => {
    it("skipped", () => {});
  });
} else {
  if (!/test/i.test(new URL(TEST_DB_URL).pathname)) {
    throw new Error("OWA_TEST_DATABASE_URL 的库名须含 test");
  }
  const { db, pool } = createDb(TEST_DB_URL);
  const sessions = new MysqlSessionRepo(db);
  const runs = new MysqlRunRepo(db);
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "owa-wsp-"));
  });
  afterAll(async () => {
    await pool.end();
  });

  const sid = () => `w${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  /** 一个"8 天没活动"的会话,目录里有旧文件 */
  async function oldSession(): Promise<{ id: string; dir: string }> {
    const id = sid();
    const dir = path.join(root, id);
    await sessions.create({ id, agentId: "a", workspaceDir: dir, ownerId: "u" });
    await db.execute(sql`UPDATE sessions SET created_at = NOW() - INTERVAL 8 DAY WHERE id = ${id}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "旧产出.md"), "上周的");
    return { id, dir };
  }
  const opts = (kind: "purge" | "clean" = "purge") => ({
    quietSinceMs: Date.now() - 7 * DAY,
    nowMs: Date.now(),
    kind,
  });
  const noop = async () => {};

  describe("reclaimWorkspace / prepareWorkspace(真实 MySQL)", () => {
    it("长期没活动:可回收,并记下清理时刻", async () => {
      const { id } = await oldSession();
      expect(await sessions.reclaimWorkspace(id, opts(), noop)).toBe(true);
      expect((await sessions.get(id))?.workspacePurgedAt).toBeGreaterThan(0);
    });

    it("有人刚用过(运行启动 / 上传记下的):不回收", async () => {
      const { id, dir } = await oldSession();
      await sessions.prepareWorkspace(id, { nowMs: Date.now() }, async () => {
        await fs.mkdir(dir, { recursive: true });
      });
      expect(await sessions.reclaimWorkspace(id, opts(), noop)).toBe(false);
    });

    it("保留期内有运行活动:不回收", async () => {
      const { id } = await oldSession();
      await runs.create({ id: sid(), sessionId: id, prompt: "新一轮" });
      expect(await sessions.reclaimWorkspace(id, opts(), noop)).toBe(false);
    });

    it("运行正在执行(租约有效)即使很早创建也不回收;租约过期则可以", async () => {
      const { id } = await oldSession();
      const runId = sid();
      await runs.create({ id: runId, sessionId: id, prompt: "长任务" });
      await db.execute(
        sql`UPDATE runs SET created_at = NOW() - INTERVAL 8 DAY, status = 'running', lease_until = ${Date.now() + 60_000} WHERE id = ${runId}`,
      );
      expect(await sessions.reclaimWorkspace(id, opts(), noop)).toBe(false);
      await db.execute(sql`UPDATE runs SET lease_until = ${Date.now() - 1} WHERE id = ${runId}`);
      expect(await sessions.reclaimWorkspace(id, opts(), noop)).toBe(true);
    });

    it("卡在 pending 的僵尸运行:整体清理放行(兜底占盘),清中间产物不放行", async () => {
      const { id } = await oldSession();
      const runId = sid();
      await runs.create({ id: runId, sessionId: id, prompt: "僵尸" });
      await db.execute(
        sql`UPDATE runs SET created_at = NOW() - INTERVAL 8 DAY WHERE id = ${runId}`,
      );
      expect(await sessions.reclaimWorkspace(id, opts("clean"), noop)).toBe(false);
      expect(await sessions.reclaimWorkspace(id, opts("purge"), noop)).toBe(true);
    });

    it("op 失败:整体回滚,不留下清理时刻", async () => {
      const { id } = await oldSession();
      await expect(
        sessions.reclaimWorkspace(id, opts(), async () => {
          throw new Error("rename failed");
        }),
      ).rejects.toThrow("rename failed");
      expect((await sessions.get(id))?.workspacePurgedAt).toBeUndefined();
    });
  });

  describe("GC 与新运行的并发(确定性)", () => {
    function gcWithGate(dirRoot: string) {
      let reached!: () => void;
      let release!: () => void;
      const atGate = new Promise<void>((r) => {
        reached = r;
      });
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const gc = new WorkspaceGc({
        workspacesRoot: dirRoot,
        listWorkspaces: () => runs.listSessionActivity(),
        reclaim: (id, o, op) => sessions.reclaimWorkspace(id, o, op),
        beforeMove: async () => {
          reached();
          await gate;
        },
      });
      return { gc, atGate, release };
    }

    /** "新运行":按协议准备目录,然后写一个文件 */
    async function startRun(id: string, dir: string): Promise<void> {
      await sessions.prepareWorkspace(id, { nowMs: Date.now() }, async () => {
        await fs.mkdir(dir, { recursive: true });
      });
      await fs.writeFile(path.join(dir, "本轮产出.md"), "刚写的");
    }

    it(
      "GC 判定之后暂停,新运行此时启动并写文件;恢复 GC 后运行的目录与文件都还在",
      { timeout: 30_000 },
      async () => {
        const { id, dir } = await oldSession();
        const { gc, atGate, release } = gcWithGate(root);

        const gcDone = gc.run();
        await atGate; // GC 已在锁内判定通过,停在改名之前

        let runFinished = false;
        const run = startRun(id, dir).then(() => {
          runFinished = true;
        });
        await new Promise((r) => setTimeout(r, 500));
        expect(runFinished).toBe(false); // 运行在等 GC 的行锁,没有往旧目录里写

        release();
        const report = await gcDone;
        await run;

        expect(report.purged).toBe(1);
        expect(await fs.readFile(path.join(dir, "本轮产出.md"), "utf8")).toBe("刚写的");
        expect(await fs.stat(path.join(dir, "旧产出.md")).catch(() => null)).toBeNull();
        const s = await sessions.get(id);
        expect(s?.workspacePurgedAt).toBeGreaterThan(0);
        expect(s?.workspaceTouchedAt).toBeGreaterThan(0);
      },
    );

    it("反过来:运行先按协议记下使用,GC 在锁内看到后放弃,旧文件也不动", async () => {
      const { id, dir } = await oldSession();
      await startRun(id, dir);
      const gc = new WorkspaceGc({
        workspacesRoot: root,
        listWorkspaces: async () => [{ sessionId: id, lastActiveAt: 0, finished: true }],
        reclaim: (sid2, o, op) => sessions.reclaimWorkspace(sid2, o, op),
      });
      const report = await gc.run();
      expect(report).toMatchObject({ purged: 0, spared: 1 });
      expect(await fs.readFile(path.join(dir, "旧产出.md"), "utf8")).toBe("上周的");
      expect(await fs.readFile(path.join(dir, "本轮产出.md"), "utf8")).toBe("刚写的");
    });
  });
}
