// 提问卡片的状态:由运行记录里这次提问的工具结果(刷新、翻历史都在)加上当前的待回答列表推出。纯逻辑。
//
// SDK 把回答写进工具结果:回答了是 `The user answered: "问题"="回答", "问题"="回答". Read the answers …`,
// 没回答是 `The user did not answer the questions.`,用户选择不回答是平台给的拒绝说明(isError)。
// 实测见 scripts/sdk-probe/ask-user-question.mjs。

import type { AgentEvent, AskedQuestion } from "@/lib/shared";

export type QuestionEvent = Extract<AgentEvent, { kind: "question" }>;
export type AnswerEvent = Extract<AgentEvent, { kind: "answer" }>;

/** 待回答的提问(审批通道里带 questions 的那条) */
export interface PendingAsk {
  id: string;
  toolUseId?: string;
  questions: AskedQuestion[];
  createdAt?: number;
  expiresAt: number;
}

export type QuestionState =
  /** 运行在等你回答,可以直接作答(同一轮,智能体拿到回答后继续) */
  | { kind: "pending"; request: PendingAsk }
  /** 运行中、还没查到待回答(轮询间隙) */
  | { kind: "waiting" }
  /** 已回答:每题的回答(解析不出的那题为 null,另给原文) */
  | { kind: "answered"; answers: (string | null)[]; raw: string }
  /** 选择了不回答 */
  | { kind: "declined" }
  /** 提问本身没送到用户面前(如 SDK 判定提问格式不合规),智能体已继续 */
  | { kind: "invalid" }
  /** 没有回答(超时、运行被停止),智能体已自行判断 */
  | { kind: "unanswered" }
  /** 没有结果的旧记录(以前提问不等人,靠下一条消息回答) */
  | { kind: "legacy" };

const ANSWERED_PREFIX = "The user answered:";
/** 用户选择不回答时平台给模型的拒绝说明(见 claude-sdk/options.ts 的 askInTurn) */
export const DECLINED_MARK = "用户选择不回答这些问题";
const ANSWERED_TAIL = ". Read the answers";

/**
 * 按题目原文从 SDK 的回答文本里取出每题的回答。题目已知,逐个定位,回答里带引号也不会切错。
 * 整体对不上返回 null(界面退回显示原文)
 */
export function parseAnswered(text: string, questions: string[]): (string | null)[] | null {
  const at = text.indexOf(ANSWERED_PREFIX);
  if (at < 0) return null;
  const body = text.slice(at + ANSWERED_PREFIX.length);
  const tail = body.lastIndexOf(ANSWERED_TAIL);
  const end = tail >= 0 ? tail : body.length;
  const marks = questions.map((q) => `"${q}"="`);
  const out: (string | null)[] = [];
  let cursor = 0;
  for (const [i, mark] of marks.entries()) {
    const start = body.indexOf(mark, cursor);
    if (start < 0 || start >= end) {
      out.push(null);
      continue;
    }
    const from = start + mark.length;
    const next = marks.slice(i + 1).find((m) => body.indexOf(`, ${m}`, from) >= 0);
    let to = next ? body.indexOf(`, ${next}`, from) : end;
    // 回答以引号结束:去掉收尾的那个引号
    if (body[to - 1] === '"') to -= 1;
    out.push(body.slice(from, Math.max(from, to)));
    cursor = from;
  }
  return out.every((a) => a === null) ? null : out;
}

/**
 * answer:SDK 给出的结构化回答(每题完整、有界),优先用它。
 * 工具结果文本整段截到 4000 字,多题长回答会丢掉后面的题,只在没有结构化回答的旧记录上才解析它
 */
export function questionState(
  q: QuestionEvent,
  result: { text: string; isError: boolean } | undefined,
  pending: PendingAsk | undefined,
  running: boolean,
  answer?: AnswerEvent,
): QuestionState {
  if (answer && answer.answers.length > 0) {
    const byQuestion = new Map(answer.answers.map((a) => [a.question, a.answer]));
    return {
      kind: "answered",
      answers: q.questions.map(
        (x, i) => byQuestion.get(x.question) ?? answer.answers[i]?.answer ?? null,
      ),
      raw: result?.text ?? "",
    };
  }
  if (result) {
    if (result.isError) {
      // 只有平台给出的"用户选择不回答"才是不回答;其余错误(SDK 校验提问格式失败等)用户什么都没做
      return result.text.includes(DECLINED_MARK) ? { kind: "declined" } : { kind: "invalid" };
    }
    const answers = parseAnswered(
      result.text,
      q.questions.map((x) => x.question),
    );
    if (answers) return { kind: "answered", answers, raw: result.text };
    if (result.text.includes(ANSWERED_PREFIX)) {
      return { kind: "answered", answers: q.questions.map(() => null), raw: result.text };
    }
    return { kind: "unanswered" };
  }
  if (pending) return { kind: "pending", request: pending };
  if (running) return { kind: "waiting" };
  return { kind: "legacy" };
}

/** 一题的回答:选中的选项加上自己填写的(多个用"、"连接) */
export function answerText(picked: string[], other: string): string {
  return [...picked, ...(other.trim() ? [other.trim()] : [])].join("、");
}
