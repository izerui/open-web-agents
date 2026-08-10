// 历史会话回放的编排:把「一个会话跑过哪些轮」与「每轮的过程」拼成前端能直接渲染的形状。
//
// 【分工:DB 定骨架,transcript 填血肉】
// 轮次的顺序、提示词、运行 id、分支来源都来自 runs 表 —— 那是权威记录。
// jsonl 里虽然也有用户提示词,但从中反推轮次边界既脆弱又多余:SDK 换个写法就散架,
// 而 runs 表本来就精确记着这些。transcript 只负责它独有的那部分:过程事件。
//
// 【活跃轮不读 transcript】这是「历史回放」与「实时流」互不重复的结构性保证,
// 不是性能优化 —— 见下方 isActive 处的注释。

import type { TranscriptPort } from "@/lib/modules/agent-engine/ports";
import type { AgentEvent } from "@/lib/shared";

/** 一轮对话。字段与前端 workbench 的 Turn 对齐,路由可直接透传。 */
export interface HistoryTurn {
  prompt: string;
  events: AgentEvent[];
  running: boolean;
  runId: string;
  /** 从哪一轮分叉而来,界面显示分支标记。 */
  branchedFrom?: string;
}

export interface SessionHistory {
  turns: HistoryTurn[];
  /** 仍在跑的那一轮;前端据此决定要不要接回实时流。 */
  activeRunId?: string;
}

/** 本用例需要的最小依赖面 —— 只声明用到的方法,不绑定具体仓储实现。 */
export interface HistoryDeps {
  dataDir: string;
  sessions: { get(id: string): Promise<{ workspaceDir: string } | null> };
  runs: {
    listBySession(sessionId: string): Promise<
      {
        id: string;
        status: string;
        prompt: string;
        parentRunId?: string;
        sdkSessionId?: string;
        createdAt: number;
      }[]
    >;
  };
  transcript: TranscriptPort;
}

/** 尚未落终态 = 还在跑。 */
function isActive(status: string): boolean {
  return status === "pending" || status === "running";
}

/**
 * 读出一个会话的完整历史。会话不存在返回 null(由路由翻成 404)。
 */
export async function loadSessionHistory(
  deps: HistoryDeps,
  sessionId: string,
): Promise<SessionHistory | null> {
  const session = await deps.sessions.get(sessionId);
  if (!session) return null;

  const rows = [...(await deps.runs.listBySession(sessionId))].sort(
    (a, b) => a.createdAt - b.createdAt,
  );

  const turns: HistoryTurn[] = [];
  let activeRunId: string | undefined;

  for (const row of rows) {
    const active = isActive(row.status);
    if (active) activeRunId = row.id;

    let events: AgentEvent[] = [];
    // 活跃轮【刻意不读】:它的事件正由实时流推送。两边都读的话,同一批事件会从两条路
    // 进到前端,而 AgentEvent 里没有唯一 id,去不了重。让两个来源各管一段,
    // 「不重复」就成了结构上的必然,而不是靠去重逻辑兜。
    //
    // 另外这一轮的 sdkSessionId 此刻多半还没落库(它在运行结束时才写),读也读不到。
    if (!active && row.sdkSessionId) {
      try {
        events = await deps.transcript.read({
          dataDir: deps.dataDir,
          workspaceDir: session.workspaceDir,
          sdkSessionId: row.sdkSessionId,
        });
      } catch {
        // 单个文件损坏/无权读,只让这一轮空着。
        // 整体抛错的话,一个坏文件就让此前所有轮次都看不见了。
        events = [];
      }
    }

    turns.push({
      prompt: row.prompt,
      events,
      running: active,
      runId: row.id,
      branchedFrom: row.parentRunId,
    });
  }

  return { turns, activeRunId };
}
