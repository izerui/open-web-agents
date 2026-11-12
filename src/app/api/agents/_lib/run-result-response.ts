import { apiError } from "@/lib/api-error";
import { getContainer } from "@/lib/container";
import { taskFilesForResult } from "@/lib/modules/artifacts/application/task-files";
import { toRunResult } from "@/lib/modules/run/domain/run-result";

/**
 * 一次运行的结果回包:对外 result 轮询与构建页在线试调的 GET 共用同一份契约
 * (与阻塞模式、webhook 一致,见 run/domain/run-result.ts)。
 * 调用前须已完成鉴权与会话归属校验 —— 这里只负责组装。
 */
export async function runResultResponse(taskId: string, sessionId: string): Promise<Response> {
  const { runs, sessions, storage } = getContainer();
  const run = await runs.getResult(taskId);
  if (!run) return apiError(404, "not_found", "task not found");

  const result = toRunResult(run);
  // 结束之后附上工作目录的文件清单(产物);还在跑时清单不完整,不给
  const files = result.done
    ? await taskFilesForResult(storage, () => workspaceOf(sessions, sessionId))
    : { files: null, filesTruncated: false };
  return Response.json({
    ...result,
    ...files,
    /** 已废弃:同 text,保留给老的集成方 */
    summary: result.text,
  });
}

async function workspaceOf(
  sessions: { get(id: string): Promise<{ id: string; workspaceDir: string } | null> },
  sessionId: string,
) {
  const s = await sessions.get(sessionId).catch(() => null);
  return s ? { sessionId: s.id, workspaceDir: s.workspaceDir } : null;
}
