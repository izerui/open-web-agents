// 智能体设计器栏的纯逻辑:带描述进来时自动开始(取舍 1)、待确认改动挂在哪一轮、
// 处理结果留在对话里、各阶段之后的「下一步」提示(前端生成,不调模型)、积分不足、复制进来的资源来源。

/** 新建页带 ?desc= 进来:会话已载入、还没有任何轮次、这次还没试过 —— 自动把描述发给设计器 */
export function shouldAutoSend(i: {
  desc: string | undefined;
  sessionId: string;
  loading: boolean;
  hasView: boolean;
  turnCount: number;
  attempted: boolean;
  blocked: boolean;
}): boolean {
  return Boolean(
    i.desc?.trim() &&
      i.sessionId &&
      !i.loading &&
      i.hasView &&
      i.turnCount === 0 &&
      !i.attempted &&
      !i.blocked,
  );
}

/** 待确认的改动挂在最后一轮已结束的回复下面;没有就 -1(退回对话下方的面板) */
export function pendingAnchor(turns: readonly { running?: boolean }[]): number {
  for (let i = turns.length - 1; i >= 0; i--) if (!turns[i]?.running) return i;
  return -1;
}

/** 某一轮里某一节改动的处理结果 */
export interface Outcome {
  section: string;
  count: number;
  applied: boolean;
}
export type Outcomes = Record<string, Outcome[]>;

export function addOutcome(m: Outcomes, turnKey: string, o: Outcome): Outcomes {
  const rest = (m[turnKey] ?? []).filter((x) => x.section !== o.section);
  return { ...m, [turnKey]: [...rest, o] };
}

export function parseOutcomes(raw: string | null): Outcomes {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Outcomes) : {};
  } catch {
    return {};
  }
}

export const outcomesKey = (sessionId: string) => `owa.designer-outcomes.${sessionId}`;

export type NextTarget = "trial" | "eval" | "publish" | "access" | "fix";
export interface NextAction {
  label: string;
  to: NextTarget;
}
export interface NextStep {
  text: string;
  actions: NextAction[];
}
export type NextEvent =
  | { kind: "applied"; sections: string[] }
  | { kind: "caseSaved"; count: number }
  | { kind: "evalDone"; passed: number; total: number }
  | { kind: "published"; version: number };

/** 各阶段之后设计器底部的「下一步」(原型里设计器主动跟的那条带按钮的消息) */
export function nextStepFor(e: NextEvent): NextStep {
  switch (e.kind) {
    case "applied":
      return {
        text: `已应用到草稿，${e.sections.map((s) => `「${s}」`).join("")}刚更新。先用草稿试聊一条，回答满意就存成评测用例。`,
        actions: [
          { label: "试聊一条", to: "trial" },
          { label: "看评测用例", to: "eval" },
        ],
      };
    case "caseSaved":
      return {
        text: `已存为评测用例，现在共 ${e.count} 个。去评测对当前草稿跑一遍？`,
        actions: [{ label: "去评测", to: "eval" }],
      };
    case "evalDone": {
      const bad = e.total - e.passed;
      return bad > 0
        ? {
            text: `评测 ${e.passed}/${e.total} 通过，${bad} 个没过。要设计器按失败原因修改吗？`,
            actions: [{ label: `让设计器修复这 ${bad} 个`, to: "fix" }],
          }
        : {
            text: `评测 ${e.total}/${e.total} 全部通过，上线清单里前三项都齐了，可以发布。`,
            actions: [{ label: "打开上线清单", to: "publish" }],
          };
    }
    case "published":
      return {
        text: `v${e.version} 已发布。接下来签一个只给这个智能体用的 Key，复制代码就能调用。`,
        actions: [{ label: "去接入", to: "access" }],
      };
  }
}

/** 报错是积分不足:显示充值链接 */
export function needsRecharge(msg: string): boolean {
  return /积分不足|insufficient_(credits|balance)/.test(msg);
}

type RefView = {
  draft?: { skillRefs: readonly string[]; mcpRefs: readonly string[] };
  resources?: readonly { ref: string; kind: string; name: string; agentName: string }[];
} | null;

/**
 * 复制进本智能体的技能包 / MCP 来自哪个智能体:设计会话里还引用着的资源,按名字对上。
 * 后端是复制语义(取舍 5),定义里不记来源,只能从设计会话推出来。
 */
export function copiedFrom(view: RefView): {
  skill: Record<string, string>;
  mcp: Record<string, string>;
} {
  const out = { skill: {} as Record<string, string>, mcp: {} as Record<string, string> };
  if (!view?.draft) return out;
  const used = new Set([...view.draft.skillRefs, ...view.draft.mcpRefs]);
  for (const r of view.resources ?? []) {
    if (!used.has(r.ref)) continue;
    if (r.kind === "skill") out.skill[r.name] = r.agentName;
    else if (r.kind === "mcp") out.mcp[r.name] = r.agentName;
  }
  return out;
}
