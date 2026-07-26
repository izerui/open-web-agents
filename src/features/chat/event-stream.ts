// SSE 拆帧:把 fetch 的字节流切成一个个 AgentEvent。
// 纯函数式的解析核心抽出来,便于单测(不依赖浏览器)。

import type { AgentEvent } from "@/lib/shared";

/**
 * 增量拆帧器。SSE 帧以空行分隔,一帧可能跨多个 chunk 到达,
 * 故需保留残缺尾部等待后续字节。
 */
export function createSseParser(): (chunk: string) => AgentEvent[] {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    const out: AgentEvent[] = [];
    let idx = buffer.indexOf("\n\n");
    while (idx !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          out.push(JSON.parse(payload) as AgentEvent);
        } catch {
          // 半截/损坏的帧丢弃,不打断整条流
        }
      }
      idx = buffer.indexOf("\n\n");
    }
    return out;
  };
}

/** 读取 SSE 响应体,逐个事件回调。 */
export async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (e: AgentEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parse = createSseParser();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const e of parse(decoder.decode(value, { stream: true }))) onEvent(e);
  }
}
