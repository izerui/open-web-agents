// 任务工作目录里的文件清单:随运行结果一起交给接口调用方,省得再去翻目录。
//
// 列的是【整个工作目录】:invoke 每次调用一个独立工作目录,里面就是这次的输入与产出;
// API 会话里多轮共用同一个目录,清单就是到目前为止的全部文件。
// 有上限(条数、深度),超出如实标 truncated —— 完整内容走文件接口。

import type { StoragePort } from "@/lib/modules/artifacts/ports";

export interface TaskFile {
  /** 相对工作目录的路径 */
  path: string;
  size: number;
  /** 下载路径(相对本服务的根;用发起调用的同一把 Key 访问) */
  download: string;
}

export interface TaskFiles {
  files: TaskFile[];
  /** 超过条数或深度上限,清单不完整 */
  truncated: boolean;
}

export async function listTaskFiles(
  storage: Pick<StoragePort, "tree">,
  where: { sessionId: string; workspaceDir: string },
  opts: { maxFiles?: number; maxDepth?: number } = {},
): Promise<TaskFiles> {
  const maxFiles = opts.maxFiles ?? 200;
  const maxDepth = opts.maxDepth ?? 6;
  const files: TaskFile[] = [];
  let truncated = false;
  // 广度优先:浅层的文件(多半是主要产物)先进清单
  const queue: { dir: string; depth: number }[] = [{ dir: "", depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift() as { dir: string; depth: number };
    let nodes: Awaited<ReturnType<StoragePort["tree"]>>;
    try {
      nodes = await storage.tree(where.workspaceDir, dir);
    } catch (err) {
      // 工作目录已被清理(或还没建):清单为空,不是错误
      if ((err as { code?: string }).code === "ENOENT") continue;
      throw err;
    }
    for (const n of nodes.sort((a, b) => a.path.localeCompare(b.path))) {
      if (n.type === "dir") {
        if (depth + 1 < maxDepth) queue.push({ dir: n.path, depth: depth + 1 });
        else truncated = true;
        continue;
      }
      if (files.length >= maxFiles) {
        truncated = true;
        return { files, truncated };
      }
      files.push({
        path: n.path,
        size: n.size ?? 0,
        download: `/api/sessions/${encodeURIComponent(where.sessionId)}/files?download=${encodeURIComponent(n.path)}`,
      });
    }
  }
  return { files, truncated };
}

type Where = { sessionId: string; workspaceDir: string } | null;

/**
 * 给运行结果附上的文件清单:有等待上限,失败或超时返回 null —— 清单是附带信息,
 * 不能拖住或拖垮结果本身。where 可以是一个查询(如查会话拿工作目录):它也在上限之内。
 * (超时只是不再等,查询与列目录的 IO 都没有取消。)
 */
export async function taskFilesForResult(
  storage: Pick<StoragePort, "tree">,
  where: Where | (() => Promise<Where>),
  timeoutMs = 2_000,
): Promise<{ files: TaskFile[] | null; filesTruncated: boolean }> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    const r = await Promise.race([
      (async () => {
        const w = typeof where === "function" ? await where() : where;
        return w ? listTaskFiles(storage, w) : null;
      })(),
      new Promise<null>((resolve) => {
        t = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    return r
      ? { files: r.files, filesTruncated: r.truncated }
      : { files: null, filesTruncated: false };
  } catch {
    return { files: null, filesTruncated: false };
  } finally {
    clearTimeout(t);
  }
}
