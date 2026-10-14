import type { SessionSummary, Turn } from "./types";

export function sessionIdFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get("session")?.trim();
  return value || null;
}

/** ?agent=<id>:打开工作台时直接选中某个智能体(构建器"试运行"、设计会话"去试运行"用)。 */
export function agentIdFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get("agent")?.trim();
  return value || null;
}

export function withSessionInUrl(href: string, sessionId: string | null): string {
  try {
    const url = new URL(href);
    if (sessionId) url.searchParams.set("session", sessionId);
    else url.searchParams.delete("session");
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return href;
  }
}

export function filterSessionsForAgent(
  sessions: SessionSummary[],
  agentId: string,
  query: string,
): SessionSummary[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return sessions.filter((session) => {
    if (session.agentId !== agentId) return false;
    if (!normalizedQuery) return true;
    return `${session.title ?? ""} ${session.id}`.toLocaleLowerCase().includes(normalizedQuery);
  });
}

export function updateTurnByLocalId(
  turns: Turn[],
  localId: string,
  update: (turn: Turn) => Turn,
): Turn[] {
  return turns.map((turn) => (turn.localId === localId ? update(turn) : turn));
}
