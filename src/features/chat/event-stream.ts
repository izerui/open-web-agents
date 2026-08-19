// SSE 拆帧:把 fetch 的字节流切成 AgentEvent,并保留服务端提供的 Stream 游标。

import type { AgentEvent } from "@/lib/shared";

export interface SseEnvelope {
  id?: string;
  event: AgentEvent;
}

/** 增量拆帧器。SSE 帧可能跨多个 chunk,故保留残缺尾部。 */
export function createSseEnvelopeParser(): (chunk: string) => SseEnvelope[] {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk.replace(/\r\n/g, "\n");
    const out: SseEnvelope[] = [];
    let idx = buffer.indexOf("\n\n");
    while (idx !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let id: string | undefined;
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("id:")) id = line.slice(3).trim() || undefined;
        if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      const payload = data.join("\n").trim();
      if (payload) {
        try {
          out.push({ id, event: JSON.parse(payload) as AgentEvent });
        } catch {
          // 损坏帧丢弃,不打断后续事件。
        }
      }
      idx = buffer.indexOf("\n\n");
    }
    return out;
  };
}

/** 保留原有纯事件解析接口,供组件和既有测试使用。 */
export function createSseParser(): (chunk: string) => AgentEvent[] {
  const parse = createSseEnvelopeParser();
  return (chunk) => parse(chunk).map((item) => item.event);
}

/** 读取 SSE 响应体。onCursor 可用于持久化 Last-Event-ID。 */
export async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (e: AgentEvent) => void,
  onCursor?: (id: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parse = createSseEnvelopeParser();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const item of parse(decoder.decode(value, { stream: true }))) {
      if (item.id) onCursor?.(item.id);
      onEvent(item.event);
    }
  }
}
