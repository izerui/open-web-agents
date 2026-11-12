import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { canAccessSession } from "@/lib/modules/access/domain/principal";
import type { LatestRun } from "@/lib/modules/run/adapters/mysql-run-query";
import { topicOf } from "@/lib/modules/run/application/orchestrator";
import {
  type DeliveredFile,
  type WorkStep,
  latestFile,
  workStatus,
  workSteps,
} from "@/lib/modules/session/domain/recent-work";
import type { SessionListFilter } from "@/lib/modules/session/ports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIMIT = 5;
/** 从运行的事件流末尾往回读多少条找步骤(文本增量已合并,几百条够覆盖最近的工具调用) */
const STEP_EVENTS = 300;

/**
 * 探索首页「你的 AI 同事正在工作」(gaps.md A2):本人最近 5 个会话(跨智能体),
 * 每个会话最近一次运行的状态与输入 / 回答摘要,以及这次运行写出的最新文件(没有就不带)。
 *
 * 鉴权与 GET /api/sessions 的默认视图一致:网页用户只看自己在工作台里的会话(管理员也一样),
 * API Key 只看自己发起的。查询已收窄,canAccessSession 再兜一道。
 */
export async function GET(req: Request) {
  const { sessions, auth, runs, runQuery, agents, releases, storage, bus } = getContainer();
  try {
    const principal = await auth.resolveWeb(req);
    const filter: SessionListFilter =
      principal.type === "apiKey"
        ? { callerApiKeyId: principal.keyId }
        : { ownerId: principal.userId, sources: ["web"] };
    const visible = (await sessions.list(filter)).filter(
      (s) =>
        canAccessSession(principal, {
          id: s.id,
          agentId: s.agentId,
          ownerId: s.ownerId,
          callerApiKeyId: s.callerApiKeyId,
          billingUserId: s.billingUserId,
        }).allowed,
    );

    // 附加信息拿不到就不显示,不把整块拖垮(同 /api/sessions)
    const stats = await runs
      .statsBySessions(visible.map((s) => s.id))
      .catch(() => new Map<string, { runs: number; lastRunAt: number }>());
    const lastActive = (s: (typeof visible)[number]) => stats.get(s.id)?.lastRunAt ?? s.createdAt;
    const top = [...visible].sort((a, b) => lastActive(b) - lastActive(a)).slice(0, LIMIT);

    const [latest, agentRows] = await Promise.all([
      runQuery.latestBySessions(top.map((s) => s.id)).catch(() => new Map<string, LatestRun>()),
      top.length
        ? agents.list({ ids: [...new Set(top.map((s) => s.agentId))] }).catch(() => [])
        : Promise.resolve([]),
    ]);
    // 锁定发布版的会话显示发布版的名称与头像 —— 使用者看不到作者的草稿
    const published = await releases
      .publishedOf(agentRows)
      .catch(() => new Map<string, { name: string; icon?: string }>());
    const agentById = new Map(agentRows.map((a) => [a.id, a]));

    const files = await Promise.all(
      top.map(async (s): Promise<DeliveredFile | null> => {
        const run = latest.get(s.id);
        if (run?.status !== "success" || s.workspacePurgedAt) return null;
        const nodes = await storage.tree(s.workspaceDir, "").catch(() => []);
        return latestFile(nodes, { since: run.startedAt ?? run.createdAt });
      }),
    );

    /*
     * 正在工作的会话:最近 3 条工具调用或计划步骤(原型的步骤清单)。
     * 过程事件只在运行的事件流里(结束后才落 transcript),读不到(过期、Redis 不可用)就不带步骤。
     */
    const steps = await Promise.all(
      top.map(async (s): Promise<WorkStep[] | undefined> => {
        const run = latest.get(s.id);
        if (!run?.runId || (run.status !== "running" && run.status !== "pending")) return undefined;
        if (!bus.recent) return [];
        const events = await bus.recent(topicOf(s.id, run.runId), STEP_EVENTS).catch(() => []);
        return workSteps(events);
      }),
    );

    return Response.json(
      {
        sessions: top.map((s, i) => {
          const run = latest.get(s.id);
          const file = files[i] ?? null;
          const draft = agentById.get(s.agentId);
          const shown = s.agentVersion !== undefined ? published.get(s.agentId) : undefined;
          return {
            id: s.id,
            title: s.title ?? null,
            agent: {
              id: s.agentId,
              name: shown?.name ?? draft?.name ?? s.agentId,
              icon: (shown ? shown.icon : draft?.icon) ?? null,
            },
            lastActiveAt: lastActive(s),
            status: workStatus(run?.status, file),
            lastRun: run
              ? {
                  status: run.status,
                  prompt: run.promptPreview,
                  reply: run.replyPreview ?? null,
                  at: run.createdAt,
                  ...(steps[i] ? { steps: steps[i] } : {}),
                }
              : null,
            file: file ? { name: file.name, path: file.path, size: file.size ?? null } : null,
          };
        }),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
