// invoke 调用限流的端到端回归:每把 Key、每个智能体各一个每分钟窗口,
// 只约束新请求(幂等重放不受限),429 带 Retry-After 与机读的 scope。

import { beforeAll, describe, expect, it } from "vitest";
import { Client, newUser, serverUp } from "./client";

type AgentRes = { agent?: { id: string } };
type KeyRes = { plaintext?: string; key?: { id: string; rateLimitPerMinute?: number } };
type InvokeRes = {
  taskId?: string;
  replayed?: boolean;
  code?: string;
  scope?: string;
  limit?: number;
};

async function setup(tag: string) {
  const owner = await newUser(tag);
  const agentId =
    (
      await owner.post<AgentRes>("/api/agents", {
        name: tag,
        config: { systemPrompt: "p", model: "sonnet" },
      })
    ).body.agent?.id ?? "";
  return { owner, agentId };
}

describe("invoke 调用限流", () => {
  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
  });

  it("Key 单独设的上限:超出后 429(scope=key,带 Retry-After);重放不受限", async () => {
    const { owner, agentId } = await setup("rl-key");
    const key =
      (
        await owner.post<KeyRes>("/api/keys", {
          name: "limited",
          agentId,
          rateLimitPerMinute: 2,
        })
      ).body.plaintext ?? "";
    const anon = new Client("anon-rl");
    const call = (idem: string) =>
      anon.post<InvokeRes>(
        `/api/agents/${agentId}/invoke`,
        { input: `请求 ${idem}` },
        { "X-Api-Key": key, "Idempotency-Key": idem },
      );

    const first = await call("rl-1");
    expect(first.status).toBe(202);
    expect(first.headers.get("x-ratelimit-limit")).toBe("2");
    expect(first.headers.get("x-ratelimit-remaining")).toBe("1");
    expect((await call("rl-2")).headers.get("x-ratelimit-remaining")).toBe("0");

    const third = await call("rl-3");
    expect(third.status).toBe(429);
    expect(third.body.code).toBe("rate_limited");
    expect(third.body.scope).toBe("key");
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);

    // 已受理任务的重放不产生新执行,不该被限流拦住
    const replay = await call("rl-1");
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.taskId).toBe(first.body.taskId);
  });

  it("调整上限:普通用户不能高于平台默认;null 恢复默认", async () => {
    const { owner, agentId } = await setup("rl-patch");
    const k = (await owner.post<KeyRes>("/api/keys", { name: "p", agentId })).body.key?.id ?? "";
    const list = await owner.get<{ rateLimits?: { perKeyPerMinute: number } }>("/api/keys");
    const platform = list.body.rateLimits?.perKeyPerMinute ?? 0;
    expect(platform).toBeGreaterThan(0);

    const tooHigh = await owner.patch(`/api/keys?id=${k}`, { rateLimitPerMinute: platform + 1 });
    expect(tooHigh.status).toBe(400);
    const lower = await owner.patch<KeyRes>(`/api/keys?id=${k}`, { rateLimitPerMinute: 5 });
    expect(lower.status).toBe(200);
    expect(lower.body.key?.rateLimitPerMinute).toBe(5);
    const reset = await owner.patch<KeyRes>(`/api/keys?id=${k}`, { rateLimitPerMinute: null });
    expect(reset.body.key?.rateLimitPerMinute).toBeUndefined();

    // 别人的 Key 改不了
    const other = await newUser("rl-other");
    expect((await other.patch(`/api/keys?id=${k}`, { rateLimitPerMinute: 1 })).status).toBe(404);
    // 签发时的非法值同样拒绝
    expect((await owner.post("/api/keys", { name: "x", rateLimitPerMinute: 0 })).status).toBe(400);
  });

  const agentLimit = Number(process.env.OWA_E2E_INVOKE_AGENT_LIMIT ?? 0);
  it.skipIf(!agentLimit)("智能体上限按所有 Key 合计:超出后 429(scope=agent)", async () => {
    const { owner, agentId } = await setup("rl-agent");
    const keys = await Promise.all(
      [1, 2].map(
        async (i) =>
          (await owner.post<KeyRes>("/api/keys", { name: `k${i}`, agentId })).body.plaintext ?? "",
      ),
    );
    const anon = new Client("anon-agent");
    for (let i = 0; i < agentLimit; i++) {
      const r = await anon.post(
        `/api/agents/${agentId}/invoke`,
        { input: `第 ${i} 次` },
        { "X-Api-Key": keys[i % 2] as string },
      );
      expect(r.status).toBe(202);
    }
    const over = await anon.post<InvokeRes>(
      `/api/agents/${agentId}/invoke`,
      { input: "超出" },
      { "X-Api-Key": keys[0] as string },
    );
    expect(over.status).toBe(429);
    expect(over.body.scope).toBe("agent");
    expect(over.body.limit).toBe(agentLimit);
  });
});
