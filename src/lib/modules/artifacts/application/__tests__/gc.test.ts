// 真实文件系统测试:在临时目录里造工作空间,验证两层回收真的删对了东西。

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TRASH_DIR, WorkspaceGc } from "@/lib/modules/artifacts/application/gc";
import type { WorkspaceInfo } from "@/lib/modules/artifacts/domain/gc-policy";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const NOW = 1_000_000_000;
const policy = { intermediateAfterMs: 1000, purgeAfterMs: 10_000 };

let root: string;

async function makeWorkspace(id: string) {
  const dir = path.join(root, id);
  await fs.mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true });
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "report.md"), "重要产出");
  await fs.writeFile(path.join(dir, "run.log"), "x".repeat(100));
  await fs.writeFile(path.join(dir, "node_modules", "pkg", "index.js"), "y".repeat(200));
  await fs.writeFile(path.join(dir, "src", "main.py"), "print(1)");
  return dir;
}

function gcOf(list: WorkspaceInfo[], now = NOW) {
  return new WorkspaceGc({
    workspacesRoot: root,
    listWorkspaces: async () => list,
    policy,
    now: () => now,
  });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "owa-gc-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("WorkspaceGc / 清中间产物", () => {
  it("删掉临时物,保留业务产出", async () => {
    const dir = await makeWorkspace("s1");
    const report = await gcOf(
      [{ sessionId: "s1", lastActiveAt: NOW - 2000, finished: true }],
      NOW,
    ).run();

    expect(report.cleaned).toBe(1);
    // 中间产物已删
    expect(await fs.stat(path.join(dir, "node_modules")).catch(() => null)).toBeNull();
    expect(await fs.stat(path.join(dir, "run.log")).catch(() => null)).toBeNull();
    // 业务产出保留
    expect(await fs.readFile(path.join(dir, "report.md"), "utf8")).toBe("重要产出");
    expect(await fs.stat(path.join(dir, "src", "main.py"))).toBeTruthy();
  });

  it("统计释放的字节数", async () => {
    await makeWorkspace("s1");
    const report = await gcOf(
      [{ sessionId: "s1", lastActiveAt: NOW - 2000, finished: true }],
      NOW,
    ).run();
    expect(report.freedBytes).toBeGreaterThan(200);
  });
});

describe("WorkspaceGc / 清整个目录", () => {
  it("超过保留期整目录删除", async () => {
    const dir = await makeWorkspace("s1");
    const report = await gcOf(
      [{ sessionId: "s1", lastActiveAt: NOW - 20_000, finished: true }],
      NOW,
    ).run();
    expect(report.purged).toBe(1);
    expect(await fs.stat(dir).catch(() => null)).toBeNull();
  });
});

describe("WorkspaceGc / 保护正在跑的会话", () => {
  it("未结束的会话一个文件都不动", async () => {
    const dir = await makeWorkspace("s1");
    const report = await gcOf(
      [{ sessionId: "s1", lastActiveAt: NOW - 2000, finished: false }],
      NOW,
    ).run();
    expect(report.cleaned).toBe(0);
    expect(report.purged).toBe(0);
    expect(await fs.stat(path.join(dir, "node_modules"))).toBeTruthy();
  });

  it("刚活动过的会话不动", async () => {
    const dir = await makeWorkspace("s1");
    await gcOf([{ sessionId: "s1", lastActiveAt: NOW, finished: true }], NOW).run();
    expect(await fs.stat(path.join(dir, "run.log"))).toBeTruthy();
  });
});

describe("WorkspaceGc / 健壮性", () => {
  it("目录已不存在时安全跳过", async () => {
    const report = await gcOf(
      [{ sessionId: "gone", lastActiveAt: NOW - 20_000, finished: true }],
      NOW,
    ).run();
    expect(report.scanned).toBe(1);
    expect(report.purged).toBe(0);
    expect(report.errors).toEqual([]);
  });

  it("异常会话 id 被拒,绝不删到工作空间根之外", async () => {
    // 在 root 之外造一个"受害者"目录
    const victim = path.join(root, "..", `owa-victim-${path.basename(root)}`);
    await fs.mkdir(victim, { recursive: true });
    await fs.writeFile(path.join(victim, "keep.txt"), "must survive");

    const report = await gcOf(
      [
        {
          sessionId: `../owa-victim-${path.basename(root)}`,
          lastActiveAt: NOW - 20_000,
          finished: true,
        },
      ],
      NOW,
    ).run();

    expect(report.purged).toBe(0);
    expect(report.errors.length).toBe(1);
    expect(await fs.readFile(path.join(victim, "keep.txt"), "utf8")).toBe("must survive");
    await fs.rm(victim, { recursive: true, force: true });
  });

  it("多个工作空间按各自策略分别处理", async () => {
    await makeWorkspace("keep");
    await makeWorkspace("clean");
    await makeWorkspace("purge");
    const report = await gcOf(
      [
        { sessionId: "keep", lastActiveAt: NOW, finished: true },
        { sessionId: "clean", lastActiveAt: NOW - 2000, finished: true },
        { sessionId: "purge", lastActiveAt: NOW - 50_000, finished: true },
      ],
      NOW,
    ).run();
    expect(report).toMatchObject({ scanned: 3, cleaned: 1, purged: 1 });
  });
});

describe("WorkspaceGc / 走会话行锁协议(reclaim)", () => {
  const old = [{ sessionId: "s1", lastActiveAt: NOW - 20_000, finished: true }];

  it("reclaim 拒绝(锁内发现又有人用过):目录一个文件都不动,计入 spared", async () => {
    const dir = await makeWorkspace("s1");
    const gc = new WorkspaceGc({
      workspacesRoot: root,
      listWorkspaces: async () => old,
      policy,
      now: () => NOW,
      reclaim: async () => "busy" as const,
    });
    const r = await gc.run();
    expect(r).toMatchObject({ purged: 0, spared: 1 });
    expect(await fs.readFile(path.join(dir, "report.md"), "utf8")).toBe("重要产出");
    expect(await fs.stat(path.join(dir, "node_modules"))).toBeTruthy();
  });

  it("整体清理:用保留期截止时刻作条件,改名在 reclaim 的 op 里完成,回收站不留残余", async () => {
    const dir = await makeWorkspace("s1");
    const calls: { id: string; existedInOp: boolean; opts: unknown }[] = [];
    const gc = new WorkspaceGc({
      workspacesRoot: root,
      listWorkspaces: async () => old,
      policy,
      now: () => NOW,
      reclaim: async (id, opts, op) => {
        const before = (await fs.stat(dir).catch(() => null)) !== null;
        await op();
        const after = (await fs.stat(dir).catch(() => null)) !== null;
        calls.push({ id, existedInOp: before && !after, opts });
        return "reclaimed" as const;
      },
    });
    const r = await gc.run();
    expect(calls).toEqual([
      {
        id: "s1",
        existedInOp: true, // 改名发生在 op 里(也就是锁内)
        opts: { quietSinceMs: NOW - policy.purgeAfterMs, nowMs: NOW, kind: "purge" },
      },
    ]);
    expect(r.purged).toBe(1);
    expect(await fs.readdir(path.join(root, TRASH_DIR))).toEqual([]);
  });

  it("清中间产物同样走 reclaim(kind=clean),业务产出保留", async () => {
    const dir = await makeWorkspace("s1");
    const kinds: string[] = [];
    const gc = new WorkspaceGc({
      workspacesRoot: root,
      listWorkspaces: async () => [{ sessionId: "s1", lastActiveAt: NOW - 2000, finished: true }],
      policy,
      now: () => NOW,
      reclaim: async (_id, opts, op) => {
        kinds.push(opts.kind);
        return (await op()) ? ("reclaimed" as const) : ("gone" as const);
      },
    });
    const r = await gc.run();
    expect(kinds).toEqual(["clean"]);
    expect(r.cleaned).toBe(1);
    expect(await fs.stat(path.join(dir, "node_modules")).catch(() => null)).toBeNull();
    expect(await fs.readFile(path.join(dir, "report.md"), "utf8")).toBe("重要产出");
  });

  it("回收站残余按批次核对:clean 批次删除;purge 批次在无法确认提交时挪回,不删", async () => {
    await fs.mkdir(path.join(root, TRASH_DIR, "clean-s8-1", "node_modules"), { recursive: true });
    await fs.mkdir(path.join(root, TRASH_DIR, "purge-s9-123"), { recursive: true });
    await fs.writeFile(path.join(root, TRASH_DIR, "purge-s9-123", "x.md"), "x");
    // 没提供 lockSession:清理时刻未知,一律视为未确认 —— 宁可多留,不丢文件
    await gcOf([]).run();
    expect(await fs.readdir(path.join(root, TRASH_DIR))).toEqual([]);
    expect(await fs.readFile(path.join(root, "s9", "x.md"), "utf8")).toBe("x");
  });
});

describe("WorkspaceGc / 多进程互斥", () => {
  it("别的进程持有锁:本轮跳过,不扫描不删除", async () => {
    const dir = await makeWorkspace("s1");
    let listed = false;
    const gc = new WorkspaceGc({
      workspacesRoot: root,
      listWorkspaces: async () => {
        listed = true;
        return [{ sessionId: "s1", lastActiveAt: NOW - 20_000, finished: true }];
      },
      policy,
      now: () => NOW,
      acquireLock: async () => null,
    });
    const r = await gc.run();
    expect(r.skippedLocked).toBe(true);
    expect(listed).toBe(false);
    expect(await fs.stat(dir)).toBeTruthy();
  });

  it("拿到锁:跑完释放(即使中途出错)", async () => {
    let released = 0;
    const gc = new WorkspaceGc({
      workspacesRoot: root,
      listWorkspaces: async () => {
        throw new Error("db down");
      },
      policy,
      now: () => NOW,
      acquireLock: async () => ({
        release: async () => {
          released++;
        },
      }),
    });
    await expect(gc.run()).rejects.toThrow("db down");
    expect(released).toBe(1);
  });
});
