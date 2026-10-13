// 工作空间回收执行器。策略判定在 domain,这里只负责按判定动手。
//
// 【和新运行、上传的并发】判定基于扫描时的活动快照;扫描之后有人发起新运行或上传文件,
// 若此时再删目录,正在运行的任务会丢文件。所以动手一律走会话行锁协议(reclaim):
// 在锁内重新判定、在锁内把目标改名挪进回收站,放锁之后再慢慢删。写方(运行启动、上传)
// 动手前也要拿同一把锁记下"刚用过"(见 SessionRepo.prepareWorkspace)。
//
// 【半完成状态】事务只能回滚数据库,撤不回已经成功的改名:目录挪进了回收站、随后事务提交
// 失败(或进程在两步之间退出、连接断开自动回滚),库里没有清理时刻,文件却已离开工作目录。
// 所以回收站里的整批清理【先核对再删】:库里的清理时刻与批次时刻一致(事务确已提交)才删;
// 不一致就挪回原处;原处已有新目录(失败之后又有人写了)就挪进 .orphaned 留存、报错,
// 绝不自动删除。每轮开始时、以及本进程 reclaim 抛错时都做这次核对。
//
// 【核对也在会话行锁里】两个 GC 同时跑时(Redis 锁故障即放行),A 改名之后、提交之前,
// B 若在锁外读清理时刻,会把 A 正在处理的批次当成"未提交的遗留"挪回去,随后 A 提交成功 ——
// 库里显示已清理,目录却回来了。所以核对、删除、挪回、留存都在该会话的行锁里做:B 会等
// A 的事务结束,读到的是确定的结果;锁等待超时就不动这一批,下一轮再核对。

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
/** 核对后无法挪回原处的整批清理:留存待人工处理,GC 永不自动删除。 */
export const ORPHANED_DIR = ".orphaned";

/** 回收站批次名:<kind>-<会话 id>-<时刻>。purge 批次的时刻就是写进库里的清理时刻。 */
function batchName(kind: "purge" | "clean", sessionId: string, at: number): string {
  return `${kind}-${sessionId}-${at}`;
}

function parseBatch(
  name: string,
): { kind: "purge" | "clean"; sessionId: string; at: number } | null {
  const m = /^(purge|clean)-(.+)-(\d+)$/.exec(name);
  if (!m) return null;
  return { kind: m[1] as "purge" | "clean", sessionId: m[2] as string, at: Number(m[3]) };
}

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
   * 在会话行锁内拿到库里的清理时刻并执行 fn(见 SessionRepo.withWorkspaceLock),
   * 用来核对回收站批次。不提供则不加锁、清理时刻一律视为未知:只挪回 / 留存,不删除
   * (宁可多留,不丢文件;仅测试用)。
   */
  lockSession?<T>(sessionId: string, fn: (purgedAt: number | undefined) => Promise<T>): Promise<T>;
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
    // 上一轮留下的批次(进程中途退出、提交失败):逐个核对后再处理,不整体清空
    await this.reconcileTrash(report);

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
      const bin = path.join(
        trash,
        batchName(action === "purge" ? "purge" : "clean", ws.sessionId, now),
      );
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
        // 改名可能已经发生而事务没提交:就地核对这一批,别让文件只待在回收站里
        if (await exists(bin)) await this.settleBatch(path.basename(bin), report);
      }
    }
  }

  /** 逐个核对回收站里的批次。 */
  private async reconcileTrash(report: GcReport): Promise<void> {
    const trash = path.join(this.deps.workspacesRoot, TRASH_DIR);
    const names = await fs.readdir(trash).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") report.errors.push(`回收站读取失败:${err.message}`);
      return [] as string[];
    });
    for (const name of names) await this.settleBatch(name, report);
  }

  /**
   * 处理回收站里的一批:
   * - clean 批次:中间产物本来就要删,库里也不记任何东西 —— 直接删;
   * - purge 批次:库里的清理时刻与批次时刻一致才删;否则挪回原处,原处已被重建则挪进
   *   .orphaned 留存并报错;
   * - 认不出的名字:不动,报错。
   */
  private async settleBatch(name: string, report: GcReport): Promise<void> {
    const b = parseBatch(name);
    if (!b) {
      report.errors.push(`回收站里有认不出的条目,未处理:${name}`);
      return;
    }
    const lock =
      this.deps.lockSession ??
      (<T>(_id: string, fn: (purgedAt: number | undefined) => Promise<T>) => fn(undefined));
    try {
      // 在会话行锁内核对:另一个 GC 正在改名 / 提交时,这里等它结束
      await lock(b.sessionId, (purgedAt) => this.settleLocked(name, b, purgedAt, report));
    } catch (err) {
      // 包括锁等待超时:这一批原样不动,下一轮再核对
      report.errors.push(
        `回收站批次 ${name} 处理失败:${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async settleLocked(
    name: string,
    b: { kind: "purge" | "clean"; sessionId: string; at: number },
    purgedAt: number | undefined,
    report: GcReport,
  ): Promise<void> {
    const root = this.deps.workspacesRoot;
    const at = path.join(root, TRASH_DIR, name);
    // 拿到锁时可能已被别人(另一个 GC、本批的提交方)处理掉了
    if (!(await exists(at))) return;
    if (b.kind === "clean") {
      await fs.rm(at, { recursive: true, force: true });
      return;
    }
    // 锁内读到的清理时刻是确定的:与批次时刻一致说明那次清理确已提交
    if (purgedAt === b.at) {
      await fs.rm(at, { recursive: true, force: true });
      return;
    }
    const home = resolveInWorkspace(root, b.sessionId);
    if (!(await exists(home))) {
      await fs.rename(at, home);
      report.errors.push(`${b.sessionId}: 清理未提交,工作目录已挪回原处`);
      return;
    }
    const keep = path.join(root, ORPHANED_DIR, name);
    await fs.mkdir(path.dirname(keep), { recursive: true });
    await fs.rename(at, keep);
    report.errors.push(
      `${b.sessionId}: 清理未提交且原处已有新目录,旧文件已留存到 ${ORPHANED_DIR}/${name},需人工处理`,
    );
  }
}

async function exists(p: string): Promise<boolean> {
  return (await fs.stat(p).catch(() => null)) !== null;
}

/** 工作空间里属于中间产物的条目(只认明确的临时物,不动业务产出)。 */
async function intermediateNames(workspaceDir: string): Promise<string[]> {
  const entries = await fs.readdir(workspaceDir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => isIntermediate(e.name)).map((e) => e.name);
}
