// 文本增量合并:把连续的 text/thinking 增量攒成一条再发布。
//
// 【为什么需要】SDK 开了 includePartialMessages,模型每吐几个 token 就是一条事件。
// 一次长回答上千条,而每个运行的 Redis Stream 有长度上限 —— 断线重连时,
// 开头那部分早已被裁掉,回放出来的回答缺了前半截。合并之后事件数降一到两个数量级,
// 实时性只损失一个很短的窗口(默认 80ms),人眼看不出差别。
//
// 只合并"同一种、同一个子代理"的相邻增量;遇到任何别的事件先把缓冲冲出去,
// 保证事件的相对顺序不变。

import type { AgentEvent } from "@/lib/shared";

type Mergeable = Extract<AgentEvent, { kind: "text" } | { kind: "thinking" }>;

function isMergeable(e: AgentEvent): e is Mergeable {
  return e.kind === "text" || e.kind === "thinking";
}

export interface CoalescerOptions {
  /** 攒批窗口。 */
  windowMs?: number;
  /** 单条合并事件的最大字符数,超过立刻冲出 —— 避免一条事件过大。 */
  maxChars?: number;
}

export class EventCoalescer {
  private pending: Mergeable | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly windowMs: number;
  private readonly maxChars: number;

  constructor(
    private readonly emit: (e: AgentEvent) => void,
    opts: CoalescerOptions = {},
  ) {
    this.windowMs = opts.windowMs ?? 80;
    this.maxChars = opts.maxChars ?? 4000;
  }

  push(e: AgentEvent): void {
    if (!isMergeable(e)) {
      this.flush();
      this.emit(e);
      return;
    }
    const p = this.pending;
    if (p && p.kind === e.kind && p.subagent === e.subagent) {
      this.pending = { ...p, text: p.text + e.text };
    } else {
      this.flush();
      this.pending = { ...e };
    }
    if ((this.pending?.text.length ?? 0) >= this.maxChars) {
      this.flush();
      return;
    }
    this.timer ??= setTimeout(() => this.flush(), this.windowMs);
  }

  /** 把缓冲冲出去。运行结束时必须调用,否则最后一段文本会丢。 */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const p = this.pending;
    this.pending = null;
    if (p) this.emit(p);
  }
}
