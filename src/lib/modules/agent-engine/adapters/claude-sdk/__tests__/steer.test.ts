// 运行中途追加消息:受理(web)× 关闭输入(worker)的并发,以及多条 result 的结局与计费。
//
// 用假 SDK 驱动【真实】的 ClaudeSdkEngine + ChannelSteerInbox + steerRun。假 SDK 的行为照
// scripts/sdk-probe/steer-late.mjs 的实测:每从输入流取到一条用户消息就答一轮、给一条 result;
// 取下一条之前先把这一轮的 result 交出去;输入流结束后收尾。
// 通道用内存实现;Redis 实现的同一语义由 redis-steer-channel.test.ts 对真实 Redis 验证。

import {
  ClaudeSdkEngine,
  type QueryFn,
} from "@/lib/modules/agent-engine/adapters/claude-sdk/runner";
import { InMemorySteerChannel } from "@/lib/modules/run/adapters/in-memory-steer-channel";
import { steerRun } from "@/lib/modules/run/application/steer";
import { ChannelSteerInbox } from "@/lib/modules/run/application/steer-inbox";
import type { SteerChannel } from "@/lib/modules/run/ports";
import type { AgentEvent, AgentSpec, RunContext } from "@/lib/shared";
import { describe, expect, it } from "vitest";

type Turn = { ok: boolean; text: string; usd: number; input: number; output: number };

/**
 * 假 SDK:第 n 次取到用户消息就按 turns[n] 答一轮。
 * stopReadingAfter:答完这么多轮就不再读输入、直接结束(模拟 CLI 退出)。
 */
function fakeSdk(
  turns: Turn[],
  opts: { stopReadingAfter?: number; seen?: string[] } = {},
): QueryFn {
  return ({ prompt }) =>
    (async function* () {
      yield { type: "system", subtype: "init", session_id: "sdk-1" };
      const it = (prompt as AsyncIterable<{ message: { content: string } }>)[
        Symbol.asyncIterator
      ]();
      for (let n = 0; ; n++) {
        if (opts.stopReadingAfter !== undefined && n >= opts.stopReadingAfter) return;
        const next = await it.next();
        if (next.done) return;
        opts.seen?.push(next.value.message.content);
        const t = turns[n] ?? { ok: true, text: "多余", usd: 0, input: 0, output: 0 };
        yield {
          type: "assistant",
          uuid: `a-${n}`,
          message: { content: [{ type: "text", text: t.text }] },
        };
        yield {
          type: "result",
          subtype: t.ok ? "success" : "error_during_execution",
          result: t.text,
          total_cost_usd: t.usd,
          usage: { input_tokens: t.input, output_tokens: t.output },
        };
      }
    })();
}

const engine = (q: QueryFn) =>
  new ClaudeSdkEngine(q, {
    sharedHome: "/data/.agent-home",
    hostHome: "/Users/operator",
    gateway: { slots: () => ({ fable: "m", opus: "m", sonnet: "m", haiku: "m" }) },
    sandboxEnabled: false,
    allowStdioMcp: false,
  });

const spec: AgentSpec = { systemPrompt: "p", model: { alias: "sonnet" }, limits: {} };
const ctx = (steer: RunContext["steer"]): RunContext => ({
  sessionId: "s1",
  workspaceDir: "/ws",
  prompt: "原始提示",
  credentials: { baseUrl: "x", key: "k" },
  env: {},
  steer,
});

/** 可控的暂停点 */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => {
    open = r;
  });
  return { open, opened };
}

const T1: Turn = { ok: true, text: "第一轮回答", usd: 0.01, input: 100, output: 10 };
const T2: Turn = { ok: true, text: "回应追加的回答", usd: 0.03, input: 120, output: 20 };

describe("追加消息 × 关闭输入", () => {
  it("接口已受理、正等结局时 worker 收到第一条 result 并关闭输入:这条仍交给模型,答复 delivered", async () => {
    const channel = new InMemorySteerChannel();
    const inbox = await ChannelSteerInbox.open(channel, "r1", { pollMs: 5 });
    const accepted = gate(); // 接口入队成功
    const resume = gate(); // 放行接口去等结局

    // 接口侧:入队成功后停在暂停点
    const api = steerRun(
      {
        channel,
        outcomeTimeoutMs: 2_000,
        afterAccept: async () => {
          accepted.open();
          await resume.opened;
        },
      },
      { runId: "r1", id: "m1", text: "顺便也看看 B" },
    );
    await accepted.opened;

    // worker 侧:这时才开始跑 —— 第一条 result 到达即关闭输入,关闭时取走那条消息交给模型
    const seen: string[] = [];
    const events: AgentEvent[] = [];
    const r = await engine(fakeSdk([T1, T2], { seen })).run(
      spec,
      ctx(inbox ?? undefined),
      (e) => events.push(e),
      new AbortController().signal,
    );
    resume.open();

    expect(await api).toEqual({ id: "m1", outcome: "delivered" });
    expect(seen).toEqual(["原始提示", "顺便也看看 B"]);
    expect(events.filter((e) => e.kind === "steer")).toEqual([
      { kind: "steer", id: "m1", text: "顺便也看看 B", outcome: "delivered" },
    ]);
    // 结局是第二轮的,不是停在第一条成功结果上
    expect(r).toMatchObject({ status: "success", summary: "回应追加的回答" });
    // 美元取最后的累计值,token 按轮累加
    expect(r.cost).toEqual({ usd: 0.03, input: 220, output: 30 });
    // 关闭之后再来的,不再受理
    expect(await channel.offer("r1", { id: "m2", text: "晚了" })).toBe("rejected");
  });

  it("worker 先关闭输入、接口才去入队:不受理,答复 not_accepting(调用方改作新消息),运行不受影响", async () => {
    const channel = new InMemorySteerChannel();
    const inbox = await ChannelSteerInbox.open(channel, "r1", { pollMs: 5 });
    const r = await engine(fakeSdk([T1])).run(
      spec,
      ctx(inbox ?? undefined),
      () => {},
      new AbortController().signal,
    );
    expect(r).toMatchObject({ status: "success", summary: "第一轮回答" });

    const api = await steerRun(
      { channel, outcomeTimeoutMs: 200 },
      { runId: "r1", id: "m1", text: "晚了一步" },
    );
    expect(api.outcome).toBe("not_accepting");
    expect(await channel.take("r1")).toEqual([]); // 没有悬在队列里
  });

  it("已受理,但模型在取到它之前就停止读输入:记为未送达,接口答 dropped,界面收到 dropped 事件", async () => {
    const channel = new InMemorySteerChannel();
    const inbox = await ChannelSteerInbox.open(channel, "r1", { pollMs: 5 });
    const accepted = gate();
    const resume = gate();
    const api = steerRun(
      {
        channel,
        outcomeTimeoutMs: 2_000,
        afterAccept: async () => {
          accepted.open();
          await resume.opened;
        },
      },
      { runId: "r1", id: "m1", text: "来不及了" },
    );
    await accepted.opened;

    const events: AgentEvent[] = [];
    const seen: string[] = [];
    // 答完第一轮就退出,不再读输入(模拟 CLI 异常退出)
    await engine(fakeSdk([T1, T2], { stopReadingAfter: 1, seen })).run(
      spec,
      ctx(inbox ?? undefined),
      (e) => events.push(e),
      new AbortController().signal,
    );
    resume.open();

    expect(await api).toEqual({ id: "m1", outcome: "dropped" });
    expect(seen).toEqual(["原始提示"]);
    expect(events.filter((e) => e.kind === "steer")).toEqual([
      { kind: "steer", id: "m1", text: "来不及了", outcome: "dropped" },
    ]);
  });
});

describe("多条 result 的结局与计费", () => {
  async function runWithSteer(turns: Turn[]) {
    const channel = new InMemorySteerChannel();
    const inbox = await ChannelSteerInbox.open(channel, "r1", { pollMs: 5 });
    await channel.offer("r1", { id: "m1", text: "追加" });
    return engine(fakeSdk(turns)).run(
      spec,
      ctx(inbox ?? undefined),
      () => {},
      new AbortController().signal,
    );
  }

  it("第一轮成功、追加引出的第二轮失败:整次运行失败,错因与正文取第二轮,花费合计", async () => {
    const r = await runWithSteer([
      T1,
      { ok: false, text: "第二轮出错了", usd: 0.05, input: 80, output: 5 },
    ]);
    expect(r.status).toBe("failed");
    expect(r.summary).toBe("第二轮出错了");
    expect(r.error).toMatchObject({ kind: "error_during_execution", message: "第二轮出错了" });
    expect(r.cost).toEqual({ usd: 0.05, input: 180, output: 15 });
  });

  it("第一轮失败、第二轮成功:以最后一条为准", async () => {
    const r = await runWithSteer([{ ok: false, text: "先错", usd: 0.01, input: 1, output: 1 }, T2]);
    expect(r).toMatchObject({ status: "success", summary: "回应追加的回答" });
    expect(r.error).toBeUndefined();
  });

  it("没有追加消息:只有一条 result,结局与花费原样", async () => {
    const channel = new InMemorySteerChannel();
    const inbox = await ChannelSteerInbox.open(channel, "r1", { pollMs: 5 });
    const r = await engine(fakeSdk([T1])).run(
      spec,
      ctx(inbox ?? undefined),
      () => {},
      new AbortController().signal,
    );
    expect(r).toMatchObject({ status: "success", summary: "第一轮回答" });
    expect(r.cost).toEqual({ usd: 0.01, input: 100, output: 10 });
  });
});

/**
 * 给通道的指定操作制造不确定:
 *   lost —— 操作真的执行了,响应却没回来(调用方拿到超时错误)
 *   fail —— 没执行就失败
 */
class Flaky implements SteerChannel {
  readonly plan = new Map<string, ("lost" | "fail")[]>();
  constructor(private readonly inner: SteerChannel) {}
  private async call<T>(op: string, run: () => Promise<T>): Promise<T> {
    const mode = this.plan.get(op)?.shift();
    if (mode === "fail") throw new Error(`${op} 失败`);
    const v = await run();
    if (mode === "lost") throw new Error(`${op} 响应丢失`);
    return v;
  }
  offer: SteerChannel["offer"] = (r, m) => this.call("offer", () => this.inner.offer(r, m));
  awaitOutcome: SteerChannel["awaitOutcome"] = (r, id, t) =>
    this.call("awaitOutcome", () => this.inner.awaitOutcome(r, id, t));
  open: SteerChannel["open"] = (r) => this.call("open", () => this.inner.open(r));
  take: SteerChannel["take"] = (r) => this.call("take", () => this.inner.take(r));
  close: SteerChannel["close"] = (r) => this.call("close", () => this.inner.close(r));
  settle: SteerChannel["settle"] = (r, id, o) =>
    this.call("settle", () => this.inner.settle(r, id, o));
  onOffer: SteerChannel["onOffer"] = (r, cb) => this.inner.onOffer(r, cb);
}

describe("通道响应丢失 / 失败:已受理的消息最终都有结局,且不会交给模型两次", () => {
  const quiet = { pollMs: 5, onError: () => {} };

  it("读取的响应连丢两次:消息仍在通道里,第三次读到并送达", async () => {
    const inner = new InMemorySteerChannel();
    const ch = new Flaky(inner);
    const inbox = await ChannelSteerInbox.open(ch, "r1", quiet);
    await ch.offer("r1", { id: "m1", text: "补充" });
    ch.plan.set("take", ["lost", "lost"]);
    const it = inbox?.next();
    const m = await it;
    expect(m).toEqual({ id: "m1", text: "补充" });
    if (m) await inbox?.delivered(m);
    expect(await inner.awaitOutcome("r1", "m1", 100)).toBe("delivered");
  });

  it("关闭的响应丢了、模型随后不再读输入:收尾时重新读到这条,记为未送达(调用方据此重发)", async () => {
    const inner = new InMemorySteerChannel();
    const ch = new Flaky(inner);
    const inbox = await ChannelSteerInbox.open(ch, "r1", quiet);
    await ch.offer("r1", { id: "m1", text: "补充" });
    ch.plan.set("take", ["fail", "fail", "fail", "fail", "fail", "fail", "fail", "fail"]);
    ch.plan.set("close", ["lost"]);
    const events: AgentEvent[] = [];
    await engine(fakeSdk([T1, T2], { stopReadingAfter: 1 })).run(
      spec,
      ctx(inbox ?? undefined),
      (e) => events.push(e),
      new AbortController().signal,
    );
    expect(await inner.awaitOutcome("r1", "m1", 100)).toBe("dropped");
    expect(events.filter((e) => e.kind === "steer")).toEqual([
      { kind: "steer", id: "m1", text: "补充", outcome: "dropped" },
    ]);
  });

  it("关闭的响应丢了、模型仍在读输入:这条消息照样会有结局,不会悬着", async () => {
    const inner = new InMemorySteerChannel();
    const ch = new Flaky(inner);
    const inbox = await ChannelSteerInbox.open(ch, "r1", quiet);
    await ch.offer("r1", { id: "m1", text: "补充" });
    ch.plan.set("take", ["fail", "fail", "fail", "fail", "fail", "fail", "fail", "fail"]);
    ch.plan.set("close", ["lost"]);
    await engine(fakeSdk([T1, T2])).run(
      spec,
      ctx(inbox ?? undefined),
      () => {},
      new AbortController().signal,
    );
    expect(["delivered", "dropped"]).toContain(await inner.awaitOutcome("r1", "m1", 100));
  });

  it("交给模型后写结局失败、模型还在干活:之后的读取还会读到它,但不会再交给模型一次", async () => {
    const inner = new InMemorySteerChannel();
    const ch = new Flaky(inner);
    const inbox = await ChannelSteerInbox.open(ch, "r1", quiet);
    if (!inbox) throw new Error("inbox");
    await ch.offer("r1", { id: "m1", text: "一" });
    const first = await inbox.next();
    expect(first?.id).toBe("m1");
    ch.plan.set("settle", ["fail"]);
    if (first) await inbox.delivered(first); // 结局没写成:m1 仍在通道里
    await ch.offer("r1", { id: "m2", text: "二" });
    expect((await inbox.next())?.id).toBe("m2"); // 不是 m1 又来一次
    await inbox.close();
    expect(await inbox.next()).toBeNull();
    // 收尾:m1 补记送达;m2 已送达
    if (first) await inbox.delivered({ id: "m2", text: "二" });
    expect(await inbox.abandon()).toEqual([]);
    expect(await inner.awaitOutcome("r1", "m1", 100)).toBe("delivered");
  });

  it("交给模型后写结局失败:收尾补记为送达,而不是误判为未送达", async () => {
    const inner = new InMemorySteerChannel();
    const ch = new Flaky(inner);
    const inbox = await ChannelSteerInbox.open(ch, "r1", quiet);
    await ch.offer("r1", { id: "m1", text: "补充" });
    ch.plan.set("settle", ["fail"]);
    const seen: string[] = [];
    const events: AgentEvent[] = [];
    await engine(fakeSdk([T1, T2], { seen })).run(
      spec,
      ctx(inbox ?? undefined),
      (e) => events.push(e),
      new AbortController().signal,
    );
    expect(seen).toEqual(["原始提示", "补充"]);
    expect(await inner.awaitOutcome("r1", "m1", 100)).toBe("delivered");
    expect(events.some((e) => e.kind === "steer" && e.outcome === "dropped")).toBe(false);
  });

  it("受理已执行但响应丢失:答 unknown(不是失败);同一 id 重试拿到定局,模型只收到一份", async () => {
    const inner = new InMemorySteerChannel();
    const ch = new Flaky(inner);
    const inbox = await ChannelSteerInbox.open(ch, "r1", quiet);
    ch.plan.set("offer", ["lost"]);
    const first = await steerRun(
      { channel: ch, outcomeTimeoutMs: 50 },
      { runId: "r1", id: "m1", text: "补充" },
    );
    expect(first.outcome).toBe("unknown");

    const seen: string[] = [];
    const run = engine(fakeSdk([T1, T2], { seen })).run(
      spec,
      ctx(inbox ?? undefined),
      () => {},
      new AbortController().signal,
    );
    // 客户端用同一 id 重试
    const retry = await steerRun(
      { channel: ch, outcomeTimeoutMs: 2_000 },
      { runId: "r1", id: "m1", text: "补充" },
    );
    await run;
    expect(retry.outcome).toBe("delivered");
    expect(seen).toEqual(["原始提示", "补充"]);
  });
});
