// 真实文件系统测试:在临时目录里造工作空间,验证两层回收真的删对了东西。

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceGc } from "@/lib/modules/artifacts/application/gc";
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
