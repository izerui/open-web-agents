// 智能体设计器栏的纯逻辑:带描述进来时自动开始(取舍 1)、待确认改动挂在哪一轮、
// 处理结果留在对话里、各阶段之后的「下一步」提示(前端生成,不调模型)、积分不足、复制进来的资源来源。

import type { DesignOutcome } from "@/lib/modules/agent/domain/design";

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

/** 某一轮里某一节改动的处理结果(存在设计会话的服务端状态里,见 POST /api/agents/design/[id]/outcomes) */
export type Outcome = DesignOutcome;
/** 轮次(运行 ID)→ 处理结果 */
export type Outcomes = Record<string, Outcome[]>;

/** rerun:到评测阶段并弹出运行确认;review:展开刚改过的那一节 */
export type NextTarget = "trial" | "eval" | "publish" | "access" | "fix" | "rerun" | "review";
export interface NextAction {
  label: string;
  to: NextTarget;
}
export interface NextStep {
  text: string;
  actions: NextAction[];
}
export type NextEvent =
  /** stale:修复类改动或已有评测用例 —— 之前的评测结论作废 */
  | { kind: "applied"; sections: string[]; stale?: boolean }
  | { kind: "caseSaved"; count: number }
  | { kind: "evalDone"; passed: number; total: number }
  | { kind: "published"; version: number };

/** 各阶段之后设计器底部的「下一步」(原型里设计器主动跟的那条带按钮的消息) */
export function nextStepFor(e: NextEvent): NextStep {
  switch (e.kind) {
    case "applied": {
      const secs = e.sections.map((s) => `「${s}」`).join("");
      if (e.stale)
        return {
          text: `已应用到草稿，${secs}刚更新。配置变了，之前的评测结论作废，需要对当前草稿重跑。`,
          actions: [
            { label: "重新运行评测", to: "rerun" },
            { label: "看看改动", to: "review" },
          ],
        };
      return {
        text: `已应用到草稿，${secs}刚更新。先用草稿试聊一条，回答满意就存成评测用例。`,
        actions: [
          { label: "试聊一条", to: "trial" },
          { label: "看评测用例", to: "eval" },
        ],
      };
    }
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

/** 单个附件上限与一次最多几个(与对话页、上传接口一致) */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 20;
/** 设计草稿文件名保留给设计器(见 domain/design 的 DRAFT_FILE;这里不引那个模块,免得带进前端包) */
const RESERVED_NAME = "design-draft.json";

/** 往设计器输入框加附件:同名替换,过大、超量、保留名不加并给出原因 */
export function addAttachments<T extends { name: string; size: number }>(
  current: readonly T[],
  incoming: readonly T[],
): { files: T[]; rejected: string[] } {
  const files = [...current];
  const rejected: string[] = [];
  for (const file of incoming) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      rejected.push(`${file.name} 超过 10MB`);
      continue;
    }
    if (file.name === RESERVED_NAME) {
      rejected.push(`${file.name} 是设计草稿专用的文件名，改个名字再添加`);
      continue;
    }
    const same = files.findIndex((f) => f.name === file.name);
    if (same >= 0) {
      files[same] = file;
      continue;
    }
    if (files.length >= MAX_ATTACHMENTS) {
      rejected.push(`一次最多 ${MAX_ATTACHMENTS} 个附件，${file.name} 没有添加`);
      continue;
    }
    files.push(file);
  }
  return { files, rejected };
}
