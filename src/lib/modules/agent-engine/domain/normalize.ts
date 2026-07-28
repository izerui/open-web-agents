// ACL(Anti-Corruption Layer):把 claude-agent-sdk 消息翻译成域内 AgentEvent。
// 这是 SDK 变更的唯一缓冲 —— 由录制回放测试守护,SDK 升级先跑这里的测试。
// 入参一律 unknown,不 import 任何 SDK 类型。

import type { AgentEvent } from "@/lib/shared";
import { redactInput, redactSecrets } from "./redact";

/** 单条文本最大保留长度,超出截断(避免撑爆 SSE 与 UI;完整产物在工作区磁盘上)。 */
const MAX_LEN = 4000;

type Asked = Extract<AgentEvent, { kind: "question" }>["questions"];

/**
 * 解析 AskUserQuestion 的入参。
 *
 * 【形状不合就返回 null,退回普通 tool_use】—— SDK 改了入参结构时,
 * 宁可退化成"显示一坨 JSON"(难看但信息没丢),也不要抛异常或渲染出一个空按钮组:
 * 那会让用户对着一个点不动的提问干等。ACL 的本分是隔离变化,不是假设变化不会发生。
 */
function parseQuestions(input: unknown): Asked | null {
  const qs = (input as { questions?: unknown })?.questions;
  if (!Array.isArray(qs) || qs.length === 0) return null;

  const out: Asked = [];
  for (const raw of qs) {
    const q = raw as {
      question?: unknown;
      header?: unknown;
      multiSelect?: unknown;
      options?: unknown;
    };
    if (typeof q.question !== "string" || !Array.isArray(q.options)) return null;

    const options = q.options
      .map((o) => o as { label?: unknown; description?: unknown })
      .filter((o) => typeof o.label === "string" && o.label.trim() !== "")
      .map((o) => ({
        label: clip(o.label as string),
        description: typeof o.description === "string" ? clip(o.description) : undefined,
      }));
    // 一个选项都没有的提问点不了,不如退回原始形态让用户至少看得见内容
    if (options.length === 0) return null;

    out.push({
      question: clip(q.question),
      header: typeof q.header === "string" ? clip(q.header) : undefined,
      multiSelect: q.multiSelect === true,
      options,
    });
  }
  return out;
}

function clip(s: string): string {
  return s.length <= MAX_LEN ? s : `${s.slice(0, MAX_LEN)}\n…(已截断,共 ${s.length} 字)`;
}

/** tool_result 的 content 可能是字符串或块数组(text/image…),统一抽成纯文本。 */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const blk = b as { type?: string; text?: unknown } | null;
        if (blk?.type === "text" && typeof blk.text === "string") return blk.text;
        return blk?.type ? `[${blk.type}]` : "";
      })
      .join("");
  }
  return content == null ? "" : String(content);
}

/** 把不透明的 parent_tool_use_id 截短,拿不到子代理名时兜底展示。 */
export function shortSubagentId(id: string): string {
  return id.length > 14 ? id.slice(0, 14) : id;
}

/** 派发子代理的工具名:SDK 现用 `Agent`,历史别名 `Task`。入参均含 subagent_type。 */
const SUBAGENT_DISPATCH_TOOLS = new Set(["Agent", "Task"]);

/**
 * 子代理归属标签解析器(有状态,按消息到达顺序逐条喂)。
 *
 * SDK 里子代理产生的每条消息带 parent_tool_use_id = 主 agent 那次派发调用的 tool_use id,
 * 它不透明、直接显示就是一串 toolu_。本解析器记录 `派发调用 id → subagent_type`,
 * 把事件的 subagent 换成可读名(如 scene-reviewer);取不到名字时兜底短 id。
 */
export function createSubagentLabeler(): (event: AgentEvent) => AgentEvent {
  const names = new Map<string, string>();
  return (event) => {
    if (event.kind === "tool_use" && SUBAGENT_DISPATCH_TOOLS.has(event.tool) && event.toolUseId) {
      const st = (event.input as { subagent_type?: unknown } | null | undefined)?.subagent_type;
      if (typeof st === "string" && st) names.set(event.toolUseId, st);
    }
    if ("subagent" in event && event.subagent) {
      event.subagent = names.get(event.subagent) ?? shortSubagentId(event.subagent);
    }
    return event;
  };
}

// ─────────────────────────── 流式增量事件 ───────────────────────────

/**
 * 把一条 SDK stream_event 翻译成域事件(增量 delta)。
 *
 * SDK 的 `stream_event` 包裹的是 Anthropic API 的 `BetaRawMessageStreamEvent`,
 * 典型子类型:
 * - `content_block_start`  → 文本/thinking/tool_use 块开始
 * - `content_block_delta`  → 增量文本 / 增量 JSON delta
 * - `content_block_stop`   → 块结束
 * - `message_start/stop/delta` → 消息级(含 usage)
 *
 * 我们只取有增量内容的 text / thinking delta。
 * tool_use 和 usage 留给完整 assistant 消息处理 —— 那里入参是完整的、
 * AskUserQuestion 也能正确解析成 question 事件。
 */
export function normalizeStreamEvent(msg: unknown): AgentEvent[] {
  if (!msg || typeof msg !== "object") return [];
  const m = msg as Record<string, unknown>;
  if (m.type !== "stream_event") return [];

  const sub = (m.parent_tool_use_id as string | undefined) ?? undefined;
  const event = m.event as Record<string, unknown> | undefined;
  if (!event || typeof event !== "object") return [];

  const eventType = event.type as string | undefined;

  // content_block_delta: 逐 token 文本增量
  if (eventType === "content_block_delta") {
    const delta = event.delta as Record<string, unknown> | undefined;
    if (!delta) return [];

    // text_delta → 文本流
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      return [{ kind: "text", text: delta.text, subagent: sub }];
    }
    // thinking_delta → 思考流
    if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
      return [{ kind: "thinking", text: delta.thinking, subagent: sub }];
    }
    return [];
  }

  return [];
}

/**
 * 把一条 SDK 消息挑成【零个或多个】域事件。
 * - assistant → 遍历所有块:text / thinking / tool_use;带 usage 则追加 usage 事件
 * - user      → tool_result(工具输出/报错,截断 + 脱敏)
 * - system / result / stream_event / 未知 → [](由 runner 单独处理)
 *
 * `skipStreamed`:流式模式下,text 和 thinking 已经通过 normalizeStreamEvent 增量推送过了,
 * 完整 assistant 消息到来时只需提取 tool_use / question / usage,避免重复。
 */
export function normalizeSdkMessage(
  msg: unknown,
  opts?: { skipStreamed?: boolean },
): AgentEvent[] {
  const out: AgentEvent[] = [];
  if (!msg || typeof msg !== "object") return out;

  const m = msg as Record<string, unknown>;
  const sub = (m.parent_tool_use_id as string | undefined) ?? undefined;
  const message = m.message as Record<string, unknown> | undefined;
  const skip = opts?.skipStreamed === true;

  if (m.type === "assistant") {
    const blocks = message?.content;
    if (!Array.isArray(blocks)) return out;

    for (const b of blocks) {
      const blk = b as {
        type?: string;
        text?: unknown;
        thinking?: unknown;
        name?: string;
        input?: unknown;
        id?: string;
      };
      if (blk?.type === "text" && typeof blk.text === "string") {
        // 流式模式下 text 已经通过 normalizeStreamEvent 逐 token 推送过了,
        // 完整消息到来时跳过以避免重复。
        if (!skip) {
          out.push({ kind: "text", text: redactSecrets(clip(blk.text)), subagent: sub });
        }
      } else if (blk?.type === "thinking" && typeof blk.thinking === "string") {
        // 同上:流式模式下 thinking 已经增量推送过了。
        if (!skip) {
          out.push({ kind: "thinking", text: redactSecrets(clip(blk.thinking)), subagent: sub });
        }
      } else if (blk?.type === "tool_use") {
        // AskUserQuestion 是"问用户"而不是"做事",翻成专门的事件类型。
        // 当成普通 tool_use 推出去的话,界面上就是一坨 JSON —— 用户根本不知道
        // 那是在问自己,而 agent 已经把选项都列好了(见 types.ts 对 question 的说明)。
        const asked = blk.name === "AskUserQuestion" ? parseQuestions(blk.input) : null;
        if (asked) {
          out.push({ kind: "question", toolUseId: blk.id, questions: asked });
        } else {
          out.push({
            kind: "tool_use",
            tool: blk.name ?? "",
            input: redactInput(blk.input),
            toolUseId: blk.id,
            subagent: sub,
          });
        }
      }
    }

    // 该条 assistant 消息的 token 用量,带 messageId 供前端按消息去重:
    // 流式下同一条消息(id 相同)会来多份 —— 装配态陆续来、最终态才带完整 output。
    // 前端按 messageId 保留最新一份再求和,input 不双算。
    const usage = message?.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    if (usage) {
      out.push({
        kind: "usage",
        messageId: typeof message?.id === "string" ? message.id : undefined,
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
      });
    }
    return out;
  }

  if (m.type === "user") {
    const blocks = message?.content;
    if (!Array.isArray(blocks)) return out;
    for (const b of blocks) {
      const blk = b as {
        type?: string;
        tool_use_id?: string;
        content?: unknown;
        is_error?: boolean;
      };
      if (blk?.type === "tool_result") {
        out.push({
          kind: "tool_result",
          toolUseId: blk.tool_use_id,
          text: redactSecrets(clip(toolResultText(blk.content))),
          isError: blk.is_error === true,
          subagent: sub,
        });
      }
    }
    return out;
  }

  return out;
}
