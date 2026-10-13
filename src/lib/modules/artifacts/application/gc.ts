// 工作空间回收执行器。策略判定在 domain,这里只负责按判定动手。
//
// 【和新运行、上传的并发】判定基于扫描时的活动快照;扫描之后有人发起新运行或上传文件,
// 若此时再删目录,正在运行的任务会丢文件。所以动手一律走会话行锁协议(reclaim):
// 在锁内重新判定、在锁内把目标改名挪进回收站,放锁之后再慢慢删。写方(运行启动、上传)
// 动手前也要拿同一把锁记下"刚用过"(见 SessionRepo.prepareWorkspace)。

import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_GC_POLICY,
  type GcPolicy,
  type WorkspaceInfo,
  decideGc,
  isIntermediate,
} from "@/lib/modules/artifacts/domain/gc-policy";
import { resolveInWorkspace } from "@/lib/modules/artifacts/domain/safe-path";

export interface GcReport {
  scanned: number;
  cleaned: number;
  purged: number;
  /** 判定要清理、但在锁内发现又有人用过(或有运行在执行)而放弃的 */
  spared: number;
  freedBytes: number;
  errors: string[];
  /** 另一个进程正在跑这一轮,本进程跳过 */
  skippedLocked?: boolean;
}

/** 删除前先挪到这里:改名是原子的,目录要么还在原处、要么已整体移走,不会删到一半。 */
export const TRASH_DIR = ".trash";

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else {
      const st = await fs.stat(p).catch(() => null);
      if (st) total += st.size;
    }
  }
  return total;
}

async function sizeOf(p: string): Promise<number> {
  const st = await fs.stat(p).catch(() => null);
  if (!st) return 0;
  return st.isDirectory() ? dirSize(p) : st.size;
}

/** 改名挪走;源已不在(另一轮已挪走)视为完成。 */
async function moveAway(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export interface GcDeps {
  /** 工作空间根目录(dataDir/workspaces)。 */
  workspacesRoot: string;
  /** 列出候选工作空间及其活动信息。 */
  listWorkspaces(): Promise<WorkspaceInfo[]>;
  policy?: GcPolicy;
  now?: () => number;
  /**
   * 在会话行锁内重新判定条件并执行 op(见 SessionRepo.reclaimWorkspace)。
   * 返回 false = 扫描之后又有人用了这个目录(新运行、上传)或有运行在执行 —— 这次不动。
   * 不提供则直接执行(仅测试用)。
   */
  reclaim?(
    sessionId: string,
    opts: { quietSinceMs: number; nowMs: number; kind: "purge" | "clean" },
    op: () => Promise<void>,
  ): Promise<boolean>;
  /** 测试用:在锁内、改名之前暂停,用来确定性地制造"判定之后有人要写"的并发。 */
  beforeMove?(sessionId: string): Promise<void>;
  /**
   * 多进程互斥:每个进程都会定时触发 GC,同一时刻只让一个真正去扫 —— 只为省掉重复扫描。
   * 正确性不靠它(拿锁失败或 Redis 故障时照常跑):防误删靠 reclaim 的会话行锁协议。
   * 返回 null = 别人正在跑,本轮跳过。不提供则不加锁。
   */
  acquireLock?(): Promise<{ release(): Promise<void> } | null>;
}

export class WorkspaceGc {
  constructor(private readonly deps: GcDeps) {}

  async run(): Promise<GcReport> {
    const report: GcReport = {
      scanned: 0,
      cleaned: 0,
      purged: 0,
      spared: 0,
      freedBytes: 0,
      errors: [],
    };
    const lock = this.deps.acquireLock ? await this.deps.acquireLock() : undefined;
    if (lock === null) return { ...report, skippedLocked: true };
    try {
      await this.scan(report);
    } finally {
      await lock?.release().catch(() => {});
    }
    return report;
  }

  private reclaim(
    sessionId: string,
    opts: { quietSinceMs: number; nowMs: number; kind: "purge" | "clean" },
    op: () => Promise<void>,
  ): Promise<boolean> {
    return this.deps.reclaim ? this.deps.reclaim(sessionId, opts, op) : op().then(() => true);
  }

  private async scan(report: GcReport): Promise<void> {
    const policy = this.deps.policy ?? DEFAULT_GC_POLICY;
    const now = (this.deps.now ?? (() => Date.now()))();
    const trash = path.join(this.deps.workspacesRoot, TRASH_DIR);
    // 上一轮挪进回收站、但没来得及删完的(进程中途退出)
    await fs.rm(trash, { recursive: true, force: true }).catch((err) => {
      report.errors.push(`回收站清理失败:${err instanceof Error ? err.message : String(err)}`);
    });

    for (const ws of await this.deps.listWorkspaces()) {
      report.scanned++;
      // 会话 id 经安全校验后拼路径,挡住异常 id 删到根外
      let dir: string;
      try {
        dir = resolveInWorkspace(this.deps.workspacesRoot, ws.sessionId);
      } catch (err) {
        report.errors.push(`${ws.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      // 目录不存在(已被清过)直接跳过。
      //
      // 【只能吞 ENOENT】—— 曾经是无类型的 .catch(() => null),把 EACCES / EIO /
      // ELOOP / ENOTDIR 一并吸收了。部署后 workspaces 卷只读或属主不对时,GC 会跳过
      // 每一个工作空间、report.errors 保持为空 —— 整轮 GC 静默无输出,磁盘无界增长。
      try {
        await fs.stat(dir);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          report.errors.push(`${ws.sessionId}: 无法访问工作空间目录(${code ?? "unknown"})`);
        }
        continue;
      }

      const action = decideGc(ws, policy, now);
      if (action === "keep") continue;
      // 本次要挪走的东西统一放到回收站里的这个目录下
      const bin = path.join(trash, `${ws.sessionId}-${now}`);
      try {
        if (action === "purge") {
          const size = await dirSize(dir);
          const done = await this.reclaim(
            ws.sessionId,
            { quietSinceMs: now - policy.purgeAfterMs, nowMs: now, kind: "purge" },
            async () => {
              await this.deps.beforeMove?.(ws.sessionId);
              await fs.mkdir(trash, { recursive: true });
              await moveAway(dir, bin);
            },
          );
          if (!done) {
            report.spared++;
            continue;
          }
          await fs.rm(bin, { recursive: true, force: true });
          report.freedBytes += size;
          report.purged++;
        } else {
          const names = await intermediateNames(dir);
          if (names.length === 0) continue;
          let size = 0;
          for (const n of names) size += await sizeOf(resolveInWorkspace(dir, n));
          const done = await this.reclaim(
            ws.sessionId,
            { quietSinceMs: now - policy.intermediateAfterMs, nowMs: now, kind: "clean" },
            async () => {
              await this.deps.beforeMove?.(ws.sessionId);
              await fs.mkdir(bin, { recursive: true });
              // 每一项都过 resolveInWorkspace,异常名字也删不到目录外
              for (const n of names) await moveAway(resolveInWorkspace(dir, n), path.join(bin, n));
            },
          );
          if (!done) {
            report.spared++;
            continue;
          }
          await fs.rm(bin, { recursive: true, force: true });
          report.freedBytes += size;
          report.cleaned++;
        }
      } catch (err) {
        report.errors.push(`${ws.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

/** 工作空间里属于中间产物的条目(只认明确的临时物,不动业务产出)。 */
async function intermediateNames(workspaceDir: string): Promise<string[]> {
  const entries = await fs.readdir(workspaceDir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => isIntermediate(e.name)).map((e) => e.name);
}
