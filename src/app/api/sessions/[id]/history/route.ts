import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { loadSessionHistory } from "@/lib/modules/run/application/history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 历史会话回放:把该会话跑过的每一轮还原成可渲染的过程。
 *
 * 【为什么需要它】此前打开一个历史会话是一片空白 —— 过程事件只活在 Redis 与进程内的
 * replay 缓冲里,运行一结束就没了。而 SDK 自己把完整过程写成了 jsonl,一直在盘上,
 * 读它即可,不必再建一张事件表重复存一遍。
 *
 * 【与 /events 的分工】本接口只回【已终态】轮次的过程;仍在跑的那一轮由 /events 推。
 * 两个来源各管一段,所以同一事件不可能来两次(AgentEvent 没有唯一 id,来两次也去不了重)。
 * `activeRunId` 就是给前端的信号:有值就去接实时流。
 *
 * 访问前必过会话归属校验 —— 过程里有工具调用参数与产出,和工作空间文件一样敏感。
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { sessions, runs, transcript, env, auth } = getContainer();

  try {
    const principal = await auth.resolveWeb(req);
    await auth.assertSessionAccess(principal, id);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const history = await loadSessionHistory(
    { dataDir: env.dataDir, sessions, runs, transcript },
    id,
  );
  if (!history) return Response.json({ error: "session not found" }, { status: 404 });

  return Response.json(history);
}
