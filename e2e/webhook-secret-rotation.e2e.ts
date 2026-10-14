// 回调签名密钥的重叠期 —— 真实服务。签名头本身由单测覆盖(e2e 起不了可达的接收端)。

import { beforeAll, describe, expect, it } from "vitest";
import { type Client, newUser, serverUp } from "./client";

type Res = { secret?: string; previousValidUntil?: string | null; error?: string };

describe("回调签名密钥的重叠期", () => {
  let me: Client;
  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
    me = await newUser("whsec");
  });

  it("首次设置没有旧密钥;换新密钥默认重叠 24 小时;graceHours 0 即刻作废;非法值 400", async () => {
    const first = await me.post<Res>("/api/me/webhook-secret", {});
    expect(first.status).toBe(201);
    expect(first.body.previousValidUntil).toBeNull();

    const second = await me.post<Res>("/api/me/webhook-secret", {});
    expect(second.body.secret).not.toBe(first.body.secret);
    const left = Date.parse(second.body.previousValidUntil ?? "") - Date.now();
    expect(left).toBeGreaterThan(23.9 * 3_600_000);
    expect(left).toBeLessThanOrEqual(24 * 3_600_000);

    const immediate = await me.post<Res>("/api/me/webhook-secret", { graceHours: 0 });
    expect(immediate.body.previousValidUntil).toBeNull();

    expect((await me.post("/api/me/webhook-secret", { graceHours: 200 })).status).toBe(400);
  });

  it("清除之后再设置:没有旧密钥可重叠", async () => {
    expect((await me.del("/api/me/webhook-secret")).status).toBe(200);
    const r = await me.post<Res>("/api/me/webhook-secret", {});
    expect(r.body.previousValidUntil).toBeNull();
  });
});
