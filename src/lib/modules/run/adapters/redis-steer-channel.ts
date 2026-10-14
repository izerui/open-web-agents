// SteerChannel 的 Redis 实现。
//
// 受理(offer)与关闭(close)各是一段 Lua,对同一个状态键互斥:offer 只在状态为 open 时入队,
// close 置 closed 并取走队列里剩下的。Redis 串行执行脚本,两者之间不存在"检查之后、入队之前
// 被关闭"的窗口 —— 已受理的消息要么被 worker 取走,要么在关闭时被取走,不会悬在队列里。
//
// 所有命令都有等待上限,Redis 不返回时调用方拿到的是错误而不是一直挂着。
// (保留离线队列:刚启动、连接还没建好时的命令排队等连接,而不是立刻报错;等待仍受上限约束。
//  超时只是不再等,排队或已发出的命令并没有取消。)

import type { SteerChannel } from "@/lib/modules/run/ports";
import Redis from "ioredis";

type Msg = { id: string; text: string };

const NOTIFY = "owa:steer:offer";
/** 状态、队列、结局保留一天:足够覆盖最长的运行,之后自然过期 */
const TTL_MS = 24 * 60 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 2_000;

const keys = (runId: string) => ({
  state: `owa:steer:${runId}:state`,
  queue: `owa:steer:${runId}:queue`,
  outcome: `owa:steer:${runId}:outcome`,
});

const OFFER = `
if redis.call('GET', KEYS[1]) ~= 'open' then return 0 end
redis.call('RPUSH', KEYS[2], ARGV[1])
redis.call('PEXPIRE', KEYS[2], ARGV[2])
redis.call('PUBLISH', ARGV[3], ARGV[4])
return 1`;

const TAKE = `
local items = redis.call('LRANGE', KEYS[1], 0, -1)
redis.call('DEL', KEYS[1])
return items`;

const CLOSE = `
redis.call('SET', KEYS[1], 'closed', 'PX', ARGV[1])
local items = redis.call('LRANGE', KEYS[2], 0, -1)
redis.call('DEL', KEYS[2])
return items`;

function bounded<T>(p: Promise<T>, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      t = setTimeout(
        () => reject(new Error(`Redis ${what} 超过 ${COMMAND_TIMEOUT_MS}ms 未返回`)),
        COMMAND_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(t));
}

function parse(items: unknown): Msg[] {
  if (!Array.isArray(items)) return [];
  const out: Msg[] = [];
  for (const raw of items) {
    try {
      const m = JSON.parse(String(raw)) as Msg;
      if (typeof m.id === "string" && typeof m.text === "string") out.push(m);
    } catch {
      // 不是我们写进去的格式:跳过
    }
  }
  return out;
}

export class RedisSteerChannel implements SteerChannel {
  private readonly cmd: Redis;
  private sub: Redis | null = null;
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(private readonly redisUrl: string) {
    this.cmd = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    this.cmd.on("error", () => {});
  }

  async offer(runId: string, m: Msg): Promise<"accepted" | "closed"> {
    const k = keys(runId);
    const r = await bounded(
      this.cmd.eval(OFFER, 2, k.state, k.queue, JSON.stringify(m), String(TTL_MS), NOTIFY, runId),
      "offer",
    );
    return Number(r) === 1 ? "accepted" : "closed";
  }

  async awaitOutcome(
    runId: string,
    id: string,
    timeoutMs: number,
  ): Promise<"delivered" | "dropped" | "pending"> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const o = await bounded(this.cmd.hget(keys(runId).outcome, id), "awaitOutcome");
      if (o === "delivered" || o === "dropped") return o;
      if (Date.now() >= deadline) return "pending";
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async open(runId: string): Promise<void> {
    await bounded(this.cmd.set(keys(runId).state, "open", "PX", TTL_MS), "open");
  }

  async take(runId: string): Promise<Msg[]> {
    return parse(await bounded(this.cmd.eval(TAKE, 1, keys(runId).queue), "take"));
  }

  async close(runId: string): Promise<Msg[]> {
    const k = keys(runId);
    return parse(await bounded(this.cmd.eval(CLOSE, 2, k.state, k.queue, String(TTL_MS)), "close"));
  }

  async settle(runId: string, id: string, outcome: "delivered" | "dropped"): Promise<void> {
    const k = keys(runId);
    await bounded(
      this.cmd.multi().hset(k.outcome, id, outcome).pexpire(k.outcome, TTL_MS).exec(),
      "settle",
    );
  }

  onOffer(runId: string, cb: () => void): () => void {
    const set = this.listeners.get(runId) ?? new Set();
    set.add(cb);
    this.listeners.set(runId, set);
    if (!this.sub) {
      const sub = new Redis(this.redisUrl, { maxRetriesPerRequest: null });
      sub.on("error", () => {});
      const join = () => void sub.subscribe(NOTIFY).catch(() => {});
      join();
      // 重连后要重新订阅;漏掉的通知由取用方的定期 take 兜住
      sub.on("ready", join);
      sub.on("message", (_ch, id: string) => {
        for (const l of this.listeners.get(id) ?? []) l();
      });
      this.sub = sub;
    }
    return () => {
      set.delete(cb);
      if (set.size === 0) this.listeners.delete(runId);
    };
  }

  async disconnect(): Promise<void> {
    await Promise.allSettled([this.cmd.quit(), this.sub?.quit()]);
  }
}
