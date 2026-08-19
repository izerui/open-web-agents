// Redis Streams 事件总线。每个 run 使用独立 stream,以 Redis ID 作为 SSE 游标。
// Streams 同时解决跨进程广播与短期断线回放;完整历史仍由 runs + SDK jsonl 提供。

import type { BusPort, StreamSubscriptionOptions, Unsubscribe } from "@/lib/modules/events/ports";
import type { AgentEvent } from "@/lib/shared";
import Redis from "ioredis";

const STREAM_MAX_LENGTH = 2_000;
const STREAM_TTL_SECONDS = 24 * 60 * 60;
const COMMAND_TIMEOUT_MS = 2_000;
const READ_BLOCK_MS = 1_000;

type RedisReadResult = [string, [string, string[]][]][] | null;

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), COMMAND_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function waitForConnection(redis: Redis): Promise<void> {
  if (redis.status === "ready") return Promise.resolve();
  if (redis.status === "end") return Promise.reject(new Error("redis connection closed"));

  return withTimeout(
    new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        redis.off("ready", onReady);
        redis.off("end", onEnd);
      };
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onEnd = () => {
        cleanup();
        reject(new Error("redis connection closed"));
      };
      redis.once("ready", onReady);
      redis.once("end", onEnd);
    }),
    "redis connection ready timeout",
  );
}

function decodeEvent(fields: string[]): AgentEvent | null {
  const index = fields.indexOf("event");
  if (index < 0 || index + 1 >= fields.length) return null;
  const payload = fields[index + 1];
  if (payload === undefined) return null;
  try {
    const value = JSON.parse(payload) as unknown;
    if (!value || typeof value !== "object" || typeof (value as AgentEvent).kind !== "string") {
      return null;
    }
    return value as AgentEvent;
  } catch {
    return null;
  }
}

export class RedisBus implements BusPort {
  private readonly command: Redis;
  private readonly readers = new Set<Redis>();

  constructor(redisUrl: string) {
    this.command = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    this.command.on("error", () => {});
  }

  async publish(topic: string, event: AgentEvent): Promise<string> {
    const result = await withTimeout(
      this.command
        .multi()
        .xadd(topic, "MAXLEN", "~", STREAM_MAX_LENGTH, "*", "event", JSON.stringify(event))
        .expire(topic, STREAM_TTL_SECONDS)
        .exec(),
      "redis stream publish timeout",
    );
    const first = result?.[0];
    if (!first || first[0] || typeof first[1] !== "string") {
      throw first?.[0] ?? new Error("redis stream publish failed");
    }
    return first[1];
  }

  subscribe(
    topic: string,
    cb: (event: AgentEvent, id: string) => void,
    options: StreamSubscriptionOptions = {},
  ): Unsubscribe {
    const reader = this.command.duplicate({
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    this.readers.add(reader);
    reader.on("error", () => {});

    let cursor = options.afterId ?? "0-0";
    let stopped = false;

    void (async () => {
      while (!stopped) {
        try {
          const rows = (await reader.call(
            "XREAD",
            "BLOCK",
            READ_BLOCK_MS,
            "COUNT",
            100,
            "STREAMS",
            topic,
            cursor,
          )) as RedisReadResult;
          for (const [, entries] of rows ?? []) {
            for (const [id, fields] of entries) {
              cursor = id;
              const event = decodeEvent(fields);
              if (!event || stopped) continue;
              try {
                cb(event, id);
              } catch {
                // 一个 SSE 消费者异常不能杀死 reader 循环。
              }
            }
          }
        } catch {
          if (!stopped) await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    })();

    return () => {
      if (stopped) return;
      stopped = true;
      this.readers.delete(reader);
      reader.disconnect();
    };
  }

  async ready(): Promise<void> {
    await waitForConnection(this.command);
    await withTimeout(
      this.command.ping().then(() => undefined),
      "redis stream ready timeout",
    );
  }

  async close(): Promise<void> {
    for (const reader of this.readers) reader.disconnect();
    this.readers.clear();
    await this.command.quit().catch(() => this.command.disconnect());
  }
}
