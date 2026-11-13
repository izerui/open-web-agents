// 对话页(/chat)界面上的判断:会话列表分组与搜索、版本徽标、新会话弹层的分组与说明、跳转地址。
// 纯函数,不碰 React,方便单测。
import { agentHref } from "@/lib/nav/routes";
import { activityOf, sessionLabel } from "./session-groups";
import type { AgentSummary, SessionSummary } from "./types";

export type ChatBucket = "今天" | "昨天" | "更早";
const ORDER: ChatBucket[] = ["今天", "昨天", "更早"];

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function bucket(ts: number, now: number): ChatBucket {
  const today = startOfDay(now);
  const day = startOfDay(ts);
  // 未来时间(时钟偏差)按今天算
  if (day >= today) return "今天";
  return Math.round((today - day) / 86_400_000) === 1 ? "昨天" : "更早";
}

/** 会话列表按日历日分成今天 / 昨天 / 更早,组内按最近活动倒序,空组不出现。 */
export function chatBuckets(
  sessions: SessionSummary[],
  now: number = Date.now(),
): { bucket: ChatBucket; sessions: SessionSummary[] }[] {
  const by = new Map<ChatBucket, SessionSummary[]>();
  for (const s of sessions) {
    const b = bucket(activityOf(s), now);
    by.set(b, [...(by.get(b) ?? []), s]);
  }
  return ORDER.filter((b) => by.has(b)).map((b) => ({
    bucket: b,
    sessions: (by.get(b) ?? []).sort((x, y) => activityOf(y) - activityOf(x)),
  }));
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 列表行里的时间:今天写时分,昨天写「昨天」,更早写月-日。 */
export function rowTime(ts: number, now: number = Date.now()): string {
  const b = bucket(ts, now);
  const d = new Date(ts);
  if (b === "今天") return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (b === "昨天") return "昨天";
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 按会话名(没有标题时是 id 前缀)与智能体名搜索,忽略大小写。 */
export function filterSessions(
  sessions: SessionSummary[],
  agentNames: ReadonlyMap<string, string>,
  query: string,
): SessionSummary[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return sessions;
  return sessions.filter((s) =>
    `${sessionLabel(s)} ${agentNames.get(s.agentId) ?? ""}`.toLocaleLowerCase().includes(q),
  );
}

/**
 * 列表行上的等待标签。当前打开的会话以审批条的实时轮询为准;
 * 其余会话用列表接口带回的计数(只有运行中的会话才有)。待确认优先于待回答。
 */
export function sessionWaitOf(
  session: SessionSummary,
  current: { id: string | null; running: boolean; wait: "approval" | "ask" | null } | null,
): "approval" | "ask" | null {
  if (current && current.id === session.id) return current.wait;
  if ((session.pendingApprovals ?? 0) > 0) return "approval";
  if ((session.pendingQuestions ?? 0) > 0) return "ask";
  return null;
}

export type BadgeTone = "warning" | "success" | "outline";

/**
 * 对话头的版本徽标:这个会话跑的是哪一版。
 * 能编辑的人跑草稿;其他人跑已发布版本;从未发布的一律跑草稿;会话建时可锁定版本。
 */
export function versionBadge({
  running,
  session,
  agent,
}: {
  running: boolean;
  session?: SessionSummary;
  agent?: AgentSummary;
}): { label: string; tone: BadgeTone; title: string } {
  if (running) return { label: "运行中", tone: "warning", title: "这一轮还在运行" };
  if (session?.agentVersion) {
    return {
      label: `v${session.agentVersion} 锁定`,
      tone: "outline",
      title: `这个会话创建时锁定在 v${session.agentVersion}，智能体之后的发布不影响它`,
    };
  }
  if (!session && agent?.canWrite !== true && agent?.publishedVersion) {
    return {
      label: `已发布 v${agent.publishedVersion}`,
      tone: "success",
      title: "你没有编辑权限，跑的是已发布版本",
    };
  }
  return {
    label: "草稿",
    tone: "warning",
    title: agent?.canWrite
      ? "你有编辑权限，跑的是草稿"
      : session
        ? "这个会话跟随草稿运行"
        : "这个智能体还没有发布过，跑的是草稿",
  };
}

export type PickerGroup = "我的" | "分享给我" | "市场" | "内置";
const PICKER_ORDER: PickerGroup[] = ["我的", "分享给我", "市场", "内置"];

/** 新会话弹层里智能体归哪一组。meId 为 null = 关闭登录的本地模式。 */
export function agentGroupOf(agent: AgentSummary, meId: string | null): PickerGroup {
  if (agent.ownerId === "system") return "内置";
  if (agent.canRead === false) return "市场";
  if (meId ? agent.ownerId === meId : agent.canWrite === true) return "我的";
  return "分享给我";
}

/** 选这个智能体开新会话,跑的是草稿还是已发布版本(与 POST /api/sessions 的规则一致)。 */
export function runTargetLabel(agent: AgentSummary): string {
  const v = agent.publishedVersion;
  if (!v) return "跑草稿，还没有发布过";
  if (agent.canWrite) {
    return `跑草稿，你有编辑权限（已发布 v${v}${agent.hasUnpublishedChanges ? "，草稿有未发布的修改" : ""}）`;
  }
  return `跑已发布 v${v}`;
}

/** 新会话弹层里每一项的说明:跑哪一版,外加分享来的是只读还是可编辑、市场的平均花费 */
export function pickerNote(agent: AgentSummary, group: PickerGroup): string {
  const target = runTargetLabel(agent);
  if (group === "分享给我") {
    const by = agent.ownerName ? `${agent.ownerName} 分享，` : "";
    return `${by}${agent.canWrite ? "可编辑" : "只读"}，${target}`;
  }
  if (group === "市场") {
    const avg = (agent as AgentSummary & { avgCredits?: number | null }).avgCredits;
    return `市场，${target}${avg ? `，平均每次约 ${avg} 积分` : ""}`;
  }
  return target;
}

export function groupPickerAgents(
  agents: AgentSummary[],
  meId: string | null,
): { group: PickerGroup; agents: AgentSummary[] }[] {
  const by = new Map<PickerGroup, AgentSummary[]>();
  for (const a of agents) {
    const g = agentGroupOf(a, meId);
    by.set(g, [...(by.get(g) ?? []), a]);
  }
  return PICKER_ORDER.filter((g) => by.has(g)).map((g) => ({
    group: g,
    agents: by.get(g) ?? [],
  }));
}

/** 智能体设计器的会话在构建页里打开;没记下目标(新建中的设计)交给旧地址在服务端解析。 */
export function designSessionHref(session: SessionSummary): string {
  const id = encodeURIComponent(session.id);
  return session.designTargetAgentId
    ? `${agentHref({ id: session.designTargetAgentId })}?designer=${id}`
    : `/agents/design?session=${id}`;
}

/** 对话头的智能体名:自己能编辑的去构建页,其他的去市场详情。 */
export function agentPageHref(agent: AgentSummary): string {
  return agent.canWrite ? agentHref({ id: agent.id }) : `/market/${encodeURIComponent(agent.id)}`;
}

const ATTACHMENT_MARK = "\n\n已上传到当前工作区的附件:\n";

/** 发送时把附件清单拼在了提示词末尾;显示时拆出来画成附件标签。 */
export function splitPromptAttachments(prompt: string): { text: string; files: string[] } {
  const at = prompt.lastIndexOf(ATTACHMENT_MARK);
  if (at < 0) return { text: prompt, files: [] };
  const files = prompt
    .slice(at + ATTACHMENT_MARK.length)
    .split("\n")
    .map((line) => line.replace(/^- /, "").trim())
    .filter(Boolean);
  return { text: prompt.slice(0, at), files };
}

/** 发送时拼进提示词的附件清单(与 splitPromptAttachments 对称)。 */
export function joinPromptAttachments(prompt: string, files: string[]): string {
  return files.length
    ? `${prompt}${ATTACHMENT_MARK}${files.map((name) => `- ${name}`).join("\n")}`
    : prompt;
}
