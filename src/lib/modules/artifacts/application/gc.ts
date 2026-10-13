// 工作空间回收执行器。策略判定在 domain,这里只负责按判定动手。

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
  /** 判定要整体清理、但动手前发现又有活动(或有运行正在执行)而放弃的 */
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

/**
 * 清掉工作空间里的中间产物(保留业务产出)。
 * 每个待删项都过一次 resolveInWorkspace —— 即便 readdir 返回了异常名字,也不会删到目录外。
 */
async function cleanIntermediate(workspaceDir: string): Promise<number> {
  let freed = 0;
  const entries = await fs.readdir(workspaceDir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!isIntermediate(e.name)) continue;
    const target = resolveInWorkspace(workspaceDir, e.name);
    freed += e.isDirectory()
      ? await dirSize(target)
      : ((await fs.stat(target).catch(() => null))?.size ?? 0);
    await fs.rm(target, { recursive: true, force: true });
  }
  return freed;
}

export interface GcDeps {
  /** 工作空间根目录(dataDir/workspaces)。 */
  workspacesRoot: string;
  /** 列出候选工作空间及其活动信息。 */
  listWorkspaces(): Promise<WorkspaceInfo[]>;
  policy?: GcPolicy;
  now?: () => number;
  /**
   * 整体清理前的条件标记(见 SessionRepo.markWorkspacePurged)。返回 false 表示扫描之后
   * 又有了活动或有运行正在执行 —— 这次不删。不提供则不做这道检查(仅测试用)。
   */
  markPurged?(sessionId: string, opts: { cutoffMs: number; nowMs: number }): Promise<boolean>;
  /**
   * 多进程互斥:每个进程都会定时触发 GC,同一时刻只让一个真正去扫。
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
      // 每一个工作空间、report.errors 保持为空,而外层只在 cleaned||purged 非零时才
      // 打日志 —— 整轮 GC 静默无输出,磁盘无界增长,唯一的信号是磁盘写满。
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
      try {
        if (action === "purge") {
          const size = await dirSize(dir);
          // 先在库里带条件地记下"已清理":扫描之后若有人发起了新一轮,这里返回 false,不删
          if (
            this.deps.markPurged &&
            !(await this.deps.markPurged(ws.sessionId, {
              cutoffMs: now - policy.purgeAfterMs,
              nowMs: now,
            }))
          ) {
            report.spared++;
            continue;
          }
          // 原子改名挪走,再慢慢删:目录不会处在"删了一半"的状态
          await fs.mkdir(trash, { recursive: true });
          const moved = path.join(trash, `${ws.sessionId}-${now}`);
          await fs.rename(dir, moved);
          await fs.rm(moved, { recursive: true, force: true });
          report.freedBytes += size;
          report.purged++;
        } else if (action === "clean-intermediate") {
          report.freedBytes += await cleanIntermediate(dir);
          report.cleaned++;
        }
      } catch (err) {
        report.errors.push(`${ws.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
