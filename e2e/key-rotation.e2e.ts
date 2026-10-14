// API Key 的有效期与轮换 —— 真实服务。

import { beforeAll, describe, expect, it } from "vitest";
import { Client, newUser, serverUp } from "./client";

type KeyRes = {
  key?: {
    id: string;
    expiresAt?: number;
    name?: string;
    agentId?: string;
    rateLimitPerMinute?: number;
  };
  plaintext?: string;
  previous?: { id: string; expiresAt: string };
  code?: string;
};

describe("API Key 有效期与轮换", () => {
  let owner: Client;
  let stranger: Client;
  let agentId = "";
  const anon = new Client("anon-rot");

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
    owner = await newUser("rot");
    stranger = await newUser("rot-x");
    agentId =
      (
        await owner.post<{ agent?: { id: string } }>("/api/agents", {
          name: `rot-${Date.now()}`,
          config: { systemPrompt: "p", model: "sonnet" },
        })
      ).body.agent?.id ?? "";
  });

  /** 用这把 Key 调一个只需鉴权的接口:200 = 可用,401 = 不可用 */
  const usable = async (plain: string) =>
    (await anon.get("/api/runs?limit=1", { "X-Api-Key": plain })).status;

  it("签发时可设有效天数;非法值 400", async () => {
    const r = await owner.post<KeyRes>("/api/keys", { name: "d30", expiresInDays: 30 });
    expect(r.status).toBe(201);
    const left = (r.body.key?.expiresAt ?? 0) - Date.now();
    expect(left).toBeGreaterThan(29 * 86_400_000);
    expect(left).toBeLessThanOrEqual(30 * 86_400_000);
    expect((await owner.post("/api/keys", { name: "bad", expiresInDays: 0 })).status).toBe(400);
  });

  it("轮换:新 Key 立即可用、同名同绑定同限额;旧 Key 在重叠期内仍可用", async () => {
    const old = await owner.post<KeyRes>("/api/keys", {
      name: "订单系统",
      agentId,
      rateLimitPerMinute: 7,
    });
    const r = await owner.post<KeyRes>(`/api/keys/${old.body.key?.id}/rotate`, { graceHours: 24 });
    expect(r.status).toBe(201);
    expect(r.body.key).toMatchObject({ name: "订单系统", agentId, rateLimitPerMinute: 7 });
    expect(r.body.key?.id).not.toBe(old.body.key?.id);
    expect(await usable(r.body.plaintext ?? "")).toBe(200);
    expect(await usable(old.body.plaintext ?? "")).toBe(200);
    const until = Date.parse(r.body.previous?.expiresAt ?? "") - Date.now();
    expect(until).toBeGreaterThan(23 * 3_600_000);
  });

  it("重叠期为 0:旧 Key 立即失效(401),新 Key 可用;已过期的 Key 不能再轮换(409)", async () => {
    const old = await owner.post<KeyRes>("/api/keys", { name: "立即切换" });
    const r = await owner.post<KeyRes>(`/api/keys/${old.body.key?.id}/rotate`, { graceHours: 0 });
    expect(r.status).toBe(201);
    expect(await usable(old.body.plaintext ?? "")).toBe(401);
    expect(await usable(r.body.plaintext ?? "")).toBe(200);
    expect((await owner.post(`/api/keys/${old.body.key?.id}/rotate`, {})).status).toBe(409);
  });

  it("别人的 Key 轮换不了(404);API Key 自己不能给自己轮换;非法重叠期 400;进审计", async () => {
    const mine = await owner.post<KeyRes>("/api/keys", { name: "别动" });
    const id = mine.body.key?.id ?? "";
    expect((await stranger.post(`/api/keys/${id}/rotate`, {})).status).toBe(404);
    const self = await anon.post(
      `/api/keys/${id}/rotate`,
      {},
      { "X-Api-Key": mine.body.plaintext ?? "" },
    );
    expect([401, 403]).toContain(self.status);
    expect((await owner.post(`/api/keys/${id}/rotate`, { graceHours: 500 })).status).toBe(400);
    expect(await usable(mine.body.plaintext ?? "")).toBe(200); // 以上都没动到它

    const a = await owner.get<{ items?: { action: string }[] }>("/api/audit?action=api_key.rotate");
    expect((a.body.items ?? []).length).toBeGreaterThan(0);
  });

  it("绑定的智能体分享已被撤销:不能借轮换延续权限(403),旧 Key 不受影响", async () => {
    const sharer = await newUser("rot-sharer");
    const shared =
      (
        await sharer.post<{ agent?: { id: string } }>("/api/agents", {
          name: `rot-shared-${Date.now()}`,
          config: { systemPrompt: "p", model: "sonnet" },
        })
      ).body.agent?.id ?? "";
    const email = (await owner.get<{ user?: { email: string } }>("/api/auth")).body.user?.email;
    const g = await sharer.post<{ grant?: { id: string } }>(`/api/agents/${shared}/share`, {
      target: email,
      permission: "read",
    });
    const k = await owner.post<KeyRes>("/api/keys", { name: "借来的", agentId: shared });
    expect(k.status).toBe(201);
    await sharer.del(`/api/agents/${shared}/share?grantId=${g.body.grant?.id}`);

    const r = await owner.post(`/api/keys/${k.body.key?.id}/rotate`, {});
    expect(r.status).toBe(403);
    // 没有签出新 Key,旧 Key 的到期时刻也没被改动
    const list = await owner.get<{ keys?: { id: string; expiresAt?: number }[] }>("/api/keys");
    expect(list.body.keys?.find((x) => x.id === k.body.key?.id)?.expiresAt).toBeUndefined();
  });
});
