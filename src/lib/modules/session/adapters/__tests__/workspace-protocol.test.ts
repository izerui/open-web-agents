// 工作目录的会话级互斥协议,对真实 MySQL + 真实文件系统。未配置 OWA_TEST_DATABASE_URL 时跳过。
//
// 核心回归:GC 判定之后、改名之前,新运行启动并写文件 —— 运行的目录与文件不能被删。

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDb } from "@/lib/db/client";
import { ORPHANED_DIR, TRASH_DIR, WorkspaceGc } from "@/lib/modules/artifacts/application/gc";
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
  /** 假装挪走了东西 */
  const noop = async () => true;

  describe("reclaimWorkspace / prepareWorkspace(真实 MySQL)", () => {
    it("长期没活动:可回收,并记下清理时刻", async () => {
      const { id } = await oldSession();
      expect(await sessions.reclaimWorkspace(id, opts(), noop)).toBe("reclaimed");
      expect((await sessions.get(id))?.workspacePurgedAt).toBeGreaterThan(0);
    });

    it("有人刚用过(运行启动 / 上传记下的):不回收", async () => {
      const { id, dir } = await oldSession();
      await sessions.prepareWorkspace(id, { nowMs: Date.now() }, async () => {
        await fs.mkdir(dir, { recursive: true });
      });
      expect(await sessions.reclaimWorkspace(id, opts(), noop)).toBe("busy");
    });

    it("保留期内有运行活动:不回收", async () => {
      const { id } = await oldSession();
      await runs.create({ id: sid(), sessionId: id, prompt: "新一轮" });
      expect(await sessions.reclaimWorkspace(id, opts(), noop)).toBe("busy");
    });

    it("运行正在执行(租约有效)即使很早创建也不回收;租约过期则可以", async () => {
      const { id } = await oldSession();
      const runId = sid();
      await runs.create({ id: runId, sessionId: id, prompt: "长任务" });
      await db.execute(
        sql`UPDATE runs SET created_at = NOW() - INTERVAL 8 DAY, status = 'running', lease_until = ${Date.now() + 60_000} WHERE id = ${runId}`,
      );
      expect(await sessions.reclaimWorkspace(id, opts(), noop)).toBe("busy");
      await db.execute(sql`UPDATE runs SET lease_until = ${Date.now() - 1} WHERE id = ${runId}`);
      expect(await sessions.reclaimWorkspace(id, opts(), noop)).toBe("reclaimed");
    });

    it("卡在 pending 的僵尸运行:整体清理放行(兜底占盘),清中间产物不放行", async () => {
      const { id } = await oldSession();
      const runId = sid();
      await runs.create({ id: runId, sessionId: id, prompt: "僵尸" });
      await db.execute(
        sql`UPDATE runs SET created_at = NOW() - INTERVAL 8 DAY WHERE id = ${runId}`,
      );
      expect(await sessions.reclaimWorkspace(id, opts("clean"), noop)).toBe("busy");
      expect(await sessions.reclaimWorkspace(id, opts("purge"), noop)).toBe("reclaimed");
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

  describe("半完成状态:改名成功但清理没提交", () => {
    const gcFor = (reclaimWrap?: (op: () => Promise<boolean>) => () => Promise<boolean>) =>
      new WorkspaceGc({
        workspacesRoot: root,
        listWorkspaces: () => runs.listSessionActivity(),
        reclaim: (id, o, op) =>
          sessions.reclaimWorkspace(id, o, reclaimWrap ? reclaimWrap(op) : op),
        lockSession: (id, fn) => sessions.withWorkspaceLock(id, (st) => fn(st?.workspacePurgedAt)),
      });
    const trash = () => path.join(root, TRASH_DIR);

    it("真实改名成功后再抛错(事务回滚):目录挪回原处,库里无清理时刻,回收站不留,并报错", async () => {
      const { id, dir } = await oldSession();
      const report = await gcFor((op) => async () => {
        expect(await op()).toBe(true); // 真的把目录挪进了回收站
        expect(await fs.stat(dir).catch(() => null)).toBeNull();
        throw new Error("commit failed");
      }).run();
      expect(report.purged).toBe(0);
      expect(report.errors.join("\n")).toMatch(/commit failed/);
      expect(report.errors.join("\n")).toMatch(/挪回原处/);
      expect(await fs.readFile(path.join(dir, "旧产出.md"), "utf8")).toBe("上周的");
      expect((await sessions.get(id))?.workspacePurgedAt).toBeUndefined();
      expect(await fs.readdir(trash()).catch(() => [])).toEqual([]);
    });

    async function leftover(id: string, at: number) {
      const bin = path.join(trash(), `purge-${id}-${at}`);
      await fs.mkdir(bin, { recursive: true });
      await fs.writeFile(path.join(bin, "旧产出.md"), "上周的");
      return bin;
    }
    // 只核对回收站、不扫描任何会话的 GC
    const reconcileOnly = () =>
      new WorkspaceGc({
        workspacesRoot: root,
        listWorkspaces: async () => [],
        lockSession: (id, fn) => sessions.withWorkspaceLock(id, (st) => fn(st?.workspacePurgedAt)),
      });

    it("进程中途退出留下的批次:未确认提交且原处为空 —— 下一轮挪回原处,而不是清空", async () => {
      const { id, dir } = await oldSession();
      await fs.rm(dir, { recursive: true, force: true });
      await leftover(id, 12345);
      await reconcileOnly().run();
      expect(await fs.readFile(path.join(dir, "旧产出.md"), "utf8")).toBe("上周的");
      expect(await fs.readdir(trash())).toEqual([]);
    });

    it("确已提交的批次(库里清理时刻与批次时刻一致):删除", async () => {
      const { id, dir } = await oldSession();
      await fs.rm(dir, { recursive: true, force: true });
      await db.execute(sql`UPDATE sessions SET workspace_purged_at = 777 WHERE id = ${id}`);
      await leftover(id, 777);
      await reconcileOnly().run();
      expect(await fs.readdir(trash())).toEqual([]);
      expect(await fs.stat(dir).catch(() => null)).toBeNull();
    });

    it("未确认提交、原处已被重建(失败后又有人写了):留存到 .orphaned 并报错,新目录不动", async () => {
      const { id, dir } = await oldSession();
      await fs.writeFile(path.join(dir, "新写的.md"), "失败之后写的");
      await leftover(id, 999);
      const report = await reconcileOnly().run();
      expect(report.errors.join("\n")).toMatch(/需人工处理/);
      expect(await fs.readFile(path.join(dir, "新写的.md"), "utf8")).toBe("失败之后写的");
      expect(
        await fs.readFile(path.join(root, ORPHANED_DIR, `purge-${id}-999`, "旧产出.md"), "utf8"),
      ).toBe("上周的");
      expect(await fs.readdir(trash())).toEqual([]);
    });

    it("认不出的批次名:不动,报错", async () => {
      await fs.mkdir(path.join(trash(), "某个旧格式-1"), { recursive: true });
      const report = await reconcileOnly().run();
      expect(report.errors.join("\n")).toMatch(/认不出/);
      expect(await fs.readdir(trash())).toEqual(["某个旧格式-1"]);
    });
  });

  describe("两个 GC 同时跑(Redis 锁失效):B 不能把 A 正在提交的批次当成遗留", () => {
    const lockSession = <T>(id: string, fn: (p: number | undefined) => Promise<T>) =>
      sessions.withWorkspaceLock(id, (st) => fn(st?.workspacePurgedAt));

    async function race(outcome: "commit" | "rollback") {
      const { id, dir } = await oldSession();
      let moved!: () => void;
      let release!: () => void;
      const atMoved = new Promise<void>((r) => {
        moved = r;
      });
      const gate = new Promise<void>((r) => {
        release = r;
      });
      // A:真实改名之后、提交之前停住(仍持有会话行锁)
      const gcA = new WorkspaceGc({
        workspacesRoot: root,
        listWorkspaces: async () => [{ sessionId: id, lastActiveAt: 0, finished: true }],
        reclaim: (sid2, o, op) =>
          sessions.reclaimWorkspace(sid2, o, async () => {
            const m = await op();
            moved();
            await gate;
            if (outcome === "rollback") throw new Error("A 提交失败");
            return m;
          }),
        lockSession,
      });
      // B:只核对回收站
      const gcB = new WorkspaceGc({
        workspacesRoot: root,
        listWorkspaces: async () => [],
        lockSession,
      });

      const aDone = gcA.run();
      await atMoved;
      expect(await fs.stat(dir).catch(() => null)).toBeNull();
      const batches = await fs.readdir(path.join(root, TRASH_DIR));
      expect(batches).toHaveLength(1);

      let bFinished = false;
      const bDone = gcB.run().then((r) => {
        bFinished = true;
        return r;
      });
      await new Promise((r) => setTimeout(r, 500));
      expect(bFinished).toBe(false); // B 在等 A 的行锁
      expect(await fs.stat(dir).catch(() => null)).toBeNull(); // 没被 B 挪回去
      expect(await fs.readdir(path.join(root, TRASH_DIR))).toEqual(batches);

      release();
      const [ra, rb] = await Promise.all([aDone, bDone]);
      return { id, dir, ra, rb };
    }

    it(
      "A 提交:最终目录已清、库里有清理时刻、回收站为空,B 没有把目录挪回",
      { timeout: 30_000 },
      async () => {
        const { id, dir, ra, rb } = await race("commit");
        expect(ra.purged).toBe(1);
        expect(await fs.stat(dir).catch(() => null)).toBeNull();
        expect((await sessions.get(id))?.workspacePurgedAt).toBeGreaterThan(0);
        expect(await fs.readdir(path.join(root, TRASH_DIR))).toEqual([]);
        expect(rb.errors.join("\n")).not.toMatch(/挪回原处/);
      },
    );

    it(
      "A 回滚:最终目录与旧文件回到原处、库里无清理时刻、回收站为空",
      { timeout: 30_000 },
      async () => {
        const { id, dir, ra } = await race("rollback");
        expect(ra.purged).toBe(0);
        expect(await fs.readFile(path.join(dir, "旧产出.md"), "utf8")).toBe("上周的");
        expect((await sessions.get(id))?.workspacePurgedAt).toBeUndefined();
        expect(await fs.readdir(path.join(root, TRASH_DIR))).toEqual([]);
      },
    );
  });

  describe("两个 GC 都走完整扫描:后到的不能覆盖先到那一批的清理标记", () => {
    const lockSession = <T>(id: string, fn: (p: number | undefined) => Promise<T>) =>
      sessions.withWorkspaceLock(id, (st) => fn(st?.workspacePurgedAt));
    const gate = () => {
      let open!: () => void;
      let reached!: () => void;
      const at = new Promise<void>((r) => {
        reached = r;
      });
      const pass = new Promise<void>((r) => {
        open = r;
      });
      return {
        at,
        open,
        wait: async () => {
          reached();
          await pass;
        },
      };
    };

    it("源目录已不存在:op 返回未挪动,不记清理标记(返回 gone)", async () => {
      const { id } = await oldSession();
      expect(await sessions.reclaimWorkspace(id, opts(), async () => false)).toBe("gone");
      expect((await sessions.get(id))?.workspacePurgedAt).toBeUndefined();
    });

    it(
      "B 先过目录检查,A 改名提交后在删除前停住;B 拿锁时无可挪 —— 标记仍属于 A,随后核对删除 A 的批次而不是恢复",
      { timeout: 30_000 },
      async () => {
        const { id, dir } = await oldSession();
        const T_A = Date.now();
        const T_B = T_A + 1000;
        const bAfterStat = gate();
        const aAfterReclaim = gate();
        const list = async () => [{ sessionId: id, lastActiveAt: 0, finished: true }];
        const deps = {
          workspacesRoot: root,
          listWorkspaces: list,
          reclaim: (
            sid2: string,
            o: { quietSinceMs: number; nowMs: number; kind: "purge" | "clean" },
            op: () => Promise<boolean>,
          ) => sessions.reclaimWorkspace(sid2, o, op),
          lockSession,
        };
        const gcB = new WorkspaceGc({
          ...deps,
          now: () => T_B,
          afterStat: () => bAfterStat.wait(),
        });
        const gcA = new WorkspaceGc({
          ...deps,
          now: () => T_A,
          afterReclaim: () => aAfterReclaim.wait(),
        });

        const bDone = gcB.run();
        await bAfterStat.at; // B 已在锁外确认目录存在
        const aDone = gcA.run();
        await aAfterReclaim.at; // A 已改名并提交,停在删除回收站批次之前
        expect((await sessions.get(id))?.workspacePurgedAt).toBe(T_A);

        bAfterStat.open();
        const rb = await bDone;
        expect(rb.purged).toBe(0);
        expect(rb.spared).toBe(0);
        // B 什么都没挪,不能把标记改成自己的时间
        expect((await sessions.get(id))?.workspacePurgedAt).toBe(T_A);

        // 模拟 A 在提交后、删除前退出:由另一轮核对来处理 A 留下的批次
        const reconcile = new WorkspaceGc({
          workspacesRoot: root,
          listWorkspaces: async () => [],
          lockSession,
        });
        const rc = await reconcile.run();
        expect(rc.errors.join("\n")).not.toMatch(/挪回原处/);
        expect(await fs.readdir(path.join(root, TRASH_DIR))).toEqual([]);
        expect(await fs.stat(dir).catch(() => null)).toBeNull(); // 没被恢复

        aAfterReclaim.open();
        await aDone;
        expect((await sessions.get(id))?.workspacePurgedAt).toBe(T_A);
        expect(await fs.stat(dir).catch(() => null)).toBeNull();
      },
    );
  });
}
