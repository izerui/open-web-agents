// ACL(Anti-Corruption Layer):把 claude-agent-sdk 消息翻译成域内 AgentEvent。
// 这是 SDK 变更的唯一缓冲 —— 由录制回放测试守护,SDK 升级先跑这里的测试。
// 入参一律 unknown,不 import 任何 SDK 类型。

import type { AgentEvent } from "@/lib/shared";
import { redactInput, redactSecrets } from "./redact";

/** 单条文本最大保留长度,超出截断(避免撑爆 SSE 与 UI;完整产物在工作区磁盘上)。 */
const MAX_LEN = 4000;

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

/**
 * 把一条 SDK 消息挑成【零个或多个】域事件。
 * - assistant → 遍历所有块:text / thinking / tool_use;带 usage 则追加 usage 事件
 * - user      → tool_result(工具输出/报错,截断 + 脱敏)
 * - system / result / stream_event / 未知 → [](由 runner 单独处理)
 */
export function normalizeSdkMessage(msg: unknown): AgentEvent[] {
  const out: AgentEvent[] = [];
  if (!msg || typeof msg !== "object") return out;

  const m = msg as Record<string, unknown>;
  const sub = (m.parent_tool_use_id as string | undefined) ?? undefined;
  const message = m.message as Record<string, unknown> | undefined;

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
        out.push({ kind: "text", text: redactSecrets(blk.text), subagent: sub });
      } else if (blk?.type === "thinking" && typeof blk.thinking === "string") {
        out.push({ kind: "thinking", text: redactSecrets(clip(blk.thinking)), subagent: sub });
      } else if (blk?.type === "tool_use") {
        out.push({
          kind: "tool_use",
          tool: blk.name ?? "",
          input: redactInput(blk.input),
          toolUseId: blk.id,
          subagent: sub,
        });
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
