import fs from "node:fs/promises";
import path from "node:path";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { topicOf } from "@/lib/modules/run/application/orchestrator";
import { cancellableRunIds } from "@/lib/modules/run/domain/cancel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TITLE = 120;

/**
 * 改标题 / 归档 / 取消归档。
 * 曾经会话只能建不能管:标题永远是第一句话或 "invoke",用久了侧栏只能靠搜索找。
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { sessions, auth } = getContainer();
  try {
    await auth.assertSessionAccess(await auth.resolveWeb(req), id);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const body = (await req.json().catch(() => ({}))) as { title?: unknown; archived?: unknown };
  const patch: { title?: string; status?: "active" | "archived" } = {};
  if (body.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim()) {
      return Response.json({ error: "标题不能为空" }, { status: 400 });
    }
    patch.title = body.title.trim().slice(0, MAX_TITLE);
  }
  if (body.archived !== undefined) {
    if (typeof body.archived !== "boolean") {
      return Response.json({ error: "archived 须为布尔值" }, { status: 400 });
    }
    patch.status = body.archived ? "archived" : "active";
  }
  await sessions.update(id, patch);
  return Response.json({ session: await sessions.get(id) });
}

/**
 * 删除会话:先停掉还在跑的运行,再标记删除并清掉工作目录。
 *
 * 软删除:运行记录保留(用量统计与计费依赖它们),会话本身视同不存在 ——
 * 列表里没有、文件与事件读不到、也不能继续运行。
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { sessions, runs, bus, auth, env, cancelSignal } = getContainer();
  try {
    await auth.assertSessionAccess(await auth.resolveWeb(req), id);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
  const session = await sessions.get(id);
  if (!session) return Response.json({ error: "session not found" }, { status: 404 });

  for (const runId of cancellableRunIds(await runs.listBySession(id))) {
    if (!(await runs.cancel(runId))) continue;
    // 落库之后立即通知执行它的 worker 停下,而不是等下一次心跳(最多 15 秒)
    await cancelSignal.publish(runId);
    await bus
      .publish(topicOf(id, runId), {
        kind: "result",
        status: "cancelled",
        summary: "会话已删除",
        runId,
      })
      .catch(() => {});
  }
  await sessions.update(id, { status: "deleted" });
  // 工作目录里可能有用户上传的文件与产物,删会话就该一起删;失败不影响删除结论,留给 GC。
  // 递归删除只允许发生在工作空间根目录之下 —— 路径来自数据库,不能无条件信任
  const root = path.join(env.dataDir, "workspaces") + path.sep;
  const target = path.resolve(session.workspaceDir);
  if (target.startsWith(root)) {
    await fs.rm(target, { recursive: true, force: true }).catch(() => {});
  }
  return Response.json({ deleted: id });
}
