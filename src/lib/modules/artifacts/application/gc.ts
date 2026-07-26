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
  freedBytes: number;
  errors: string[];
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
}

export class WorkspaceGc {
  constructor(private readonly deps: GcDeps) {}

  async run(): Promise<GcReport> {
    const policy = this.deps.policy ?? DEFAULT_GC_POLICY;
    const now = (this.deps.now ?? (() => Date.now()))();
    const report: GcReport = { scanned: 0, cleaned: 0, purged: 0, freedBytes: 0, errors: [] };

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
          report.freedBytes += await dirSize(dir);
          await fs.rm(dir, { recursive: true, force: true });
          report.purged++;
        } else if (action === "clean-intermediate") {
          report.freedBytes += await cleanIntermediate(dir);
          report.cleaned++;
        }
      } catch (err) {
        report.errors.push(`${ws.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return report;
  }
}
