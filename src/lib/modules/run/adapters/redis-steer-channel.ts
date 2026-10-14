// SteerChannel 的 Redis 实现。
//
// 【受理与关闭检查同一个状态】受理(OFFER)与关闭(CLOSE)各是一段 Lua,Redis 串行执行脚本:
// 受理只在状态为 open 时入队,关闭置 closed —— 两者之间没有"检查之后、入队之前被关闭"的窗口。
//
// 【先交接、再删除】读取(TAKE / CLOSE)只读不删;消息只在 worker 记下它的结局(SETTLE)时,
// 在同一段脚本里从队列删除。曾经 TAKE / CLOSE 先删再返回:脚本执行了、响应却超过等待上限,
// 这批消息就既没交给模型、也永远没有结局。现在响应丢了也无妨,下一次读取或收尾时还读得到。
//
// 【按消息 id 去重,每个 id 第一次执行就定局】调用方给每条消息一个稳定 id,重试时复用。
// 同一 id 再次受理:已入队的答 accepted,已有结局的答结局;不受理时也留下 rejected 记录 ——
// 等待超时的受理请求可能还在离线队列里,之后才真正执行,它看到这条记录就不会再入队。
//
// 所有命令都有等待上限。超时只是不再等,排队或已发出的命令并没有取消(见上面的去重)。

import type { SteerChannel, SteerOfferResult } from "@/lib/modules/run/ports";
import Redis from "ioredis";

type Msg = { id: string; text: string };

const NOTIFY = "owa:steer:offer";
/** 状态、队列、结局保留一天:足够覆盖最长的运行,之后自然过期 */
const TTL_MS = 24 * 60 * 60 * 1000;

const keys = (runId: string) => ({
  state: `owa:steer:${runId}:state`,
  order: `owa:steer:${runId}:order`,
  texts: `owa:steer:${runId}:texts`,
  outcome: `owa:steer:${runId}:outcome`,
});

// KEYS: state, order, texts, outcome  ARGV: id, text, ttl, channel, runId
const OFFER = `
local done = redis.call('HGET', KEYS[4], ARGV[1])
if done then return done end
if redis.call('HEXISTS', KEYS[3], ARGV[1]) == 1 then return 'accepted' end
if redis.call('GET', KEYS[1]) ~= 'open' then
  redis.call('HSET', KEYS[4], ARGV[1], 'rejected')
  redis.call('PEXPIRE', KEYS[4], ARGV[3])
  return 'rejected'
end
redis.call('HSET', KEYS[3], ARGV[1], ARGV[2])
redis.call('RPUSH', KEYS[2], ARGV[1])
for i = 2, 3 do redis.call('PEXPIRE', KEYS[i], ARGV[3]) end
redis.call('PUBLISH', ARGV[4], ARGV[5])
return 'accepted'`;

// 还没有结局的消息,按受理顺序。KEYS: order, texts
const PENDING = `
local ids = redis.call('LRANGE', KEYS[1], 0, -1)
local out = {}
for _, id in ipairs(ids) do
  local t = redis.call('HGET', KEYS[2], id)
  if t then table.insert(out, id); table.insert(out, t) end
end
return out`;

// 置 closed,并返回还没有结局的消息(不删)。KEYS: state, order, texts  ARGV: ttl
const CLOSE = `
redis.call('SET', KEYS[1], 'closed', 'PX', ARGV[1])
local ids = redis.call('LRANGE', KEYS[2], 0, -1)
local out = {}
for _, id in ipairs(ids) do
  local t = redis.call('HGET', KEYS[3], id)
  if t then table.insert(out, id); table.insert(out, t) end
end
return out`;

// KEYS: order, texts, outcome  ARGV: id, outcome, ttl
const SETTLE = `
redis.call('HSET', KEYS[3], ARGV[1], ARGV[2])
redis.call('PEXPIRE', KEYS[3], ARGV[3])
redis.call('LREM', KEYS[1], 0, ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
return 1`;

function pairs(raw: unknown): Msg[] {
  if (!Array.isArray(raw)) return [];
  const out: Msg[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    out.push({ id: String(raw[i]), text: String(raw[i + 1]) });
  }
  return out;
}

export interface RedisSteerChannelOptions {
  /** 每条命令的等待上限。 */
  commandTimeoutMs?: number;
}

export class RedisSteerChannel implements SteerChannel {
  private readonly cmd: Redis;
  private sub: Redis | null = null;
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly timeoutMs: number;

  constructor(
    private readonly redisUrl: string,
    opts: RedisSteerChannelOptions = {},
  ) {
    this.timeoutMs = opts.commandTimeoutMs ?? 2_000;
    // 保留离线队列:刚启动、连接还没建好时的命令排队等连接,而不是立刻报错
    this.cmd = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    this.cmd.on("error", () => {});
  }

  /**
   * 执行一条命令,最多等 timeoutMs。测试通过覆盖它模拟"已执行、响应迟到"。
   * 超时只是不再等:命令已发出(或在离线队列里),之后仍可能执行。
   */
  protected exec<T>(what: string, run: () => Promise<T>): Promise<T> {
    let t: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        t = setTimeout(
          () => reject(new Error(`Redis ${what} 超过 ${this.timeoutMs}ms 未返回`)),
          this.timeoutMs,
        );
      }),
    ]).finally(() => clearTimeout(t));
  }

  async offer(runId: string, m: Msg): Promise<SteerOfferResult> {
    const k = keys(runId);
    const r = await this.exec("offer", () =>
      this.cmd.eval(
        OFFER,
        4,
        k.state,
        k.order,
        k.texts,
        k.outcome,
        m.id,
        m.text,
        String(TTL_MS),
        NOTIFY,
        runId,
      ),
    );
    const s = String(r);
    return s === "accepted" || s === "rejected" || s === "delivered" || s === "dropped"
      ? s
      : "rejected";
  }

  async awaitOutcome(
    runId: string,
    id: string,
    timeoutMs: number,
  ): Promise<"delivered" | "dropped" | "pending"> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const o = await this.exec("awaitOutcome", () => this.cmd.hget(keys(runId).outcome, id));
      if (o === "delivered" || o === "dropped") return o;
      if (Date.now() >= deadline) return "pending";
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async open(runId: string): Promise<void> {
    await this.exec("open", () => this.cmd.set(keys(runId).state, "open", "PX", TTL_MS));
  }

  async take(runId: string): Promise<Msg[]> {
    const k = keys(runId);
    return pairs(await this.exec("take", () => this.cmd.eval(PENDING, 2, k.order, k.texts)));
  }

  async close(runId: string): Promise<Msg[]> {
    const k = keys(runId);
    return pairs(
      await this.exec("close", () =>
        this.cmd.eval(CLOSE, 3, k.state, k.order, k.texts, String(TTL_MS)),
      ),
    );
  }

  async settle(runId: string, id: string, outcome: "delivered" | "dropped"): Promise<void> {
    const k = keys(runId);
    await this.exec("settle", () =>
      this.cmd.eval(SETTLE, 3, k.order, k.texts, k.outcome, id, outcome, String(TTL_MS)),
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
      // 重连后要重新订阅;漏掉的通知由取用方的定期读取兜住
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
