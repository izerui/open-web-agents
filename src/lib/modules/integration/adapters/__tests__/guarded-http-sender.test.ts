// 守卫发送器对真实本地 HTTP 服务的测试:断言的是"连接真正打到了哪里",不是函数有没有被调用。

import http from "node:http";
import type { AddressInfo } from "node:net";
import { createGuardedSender } from "@/lib/modules/integration/adapters/guarded-http-sender";
import {
  WebhookTargetRejected,
  deliverWebhook,
} from "@/lib/modules/integration/application/webhook";
import { isAddressAllowed } from "@/lib/modules/integration/domain/webhook-policy";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/** 跑在回环地址上的"内网服务" —— 攻击想打到的就是它。 */
let server: http.Server;
let port = 0;
let hits: { url?: string; host?: string; body: string }[] = [];
/** 服务端看到的连接,用来断言发送完成后连接真的被释放。 */
let sockets: import("node:net").Socket[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      hits.push({ url: req.url, host: req.headers.host, body });
      if (req.url === "/hang") {
        // 只发响应头,body 永远不结束 —— 想把平台的出站连接一直占着
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.write("partial");
        return;
      }
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: "/internal-admin" });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end("ok");
    });
  });
  server.on("connection", (sock) => {
    sockets.push(sock);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});
beforeEach(() => {
  hits = [];
  sockets = [];
});

const payload = { taskId: "t1", status: "success" };
const publicOnly = (ip: string) => isAddressAllowed(ip, false);
const noSleep = async () => {};

describe("createGuardedSender", () => {
  it("【DNS rebinding 回归】检查时解析到公网、连接时解析到回环:连接被拒,回环服务收不到请求", async () => {
    // 攻击者控制的 DNS:第一次回答公网地址,之后回答 127.0.0.1
    let calls = 0;
    const resolve = async () => {
      calls++;
      return calls === 1
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "127.0.0.1", family: 4 }];
    };

    // 检查阶段(旧实现的预检查 / 保存时校验)看到的是公网地址,检查会通过
    const checked = await resolve();
    expect(publicOnly(checked[0]?.address ?? "")).toBe(true);

    // 连接阶段:同一个域名此刻解析到回环。旧实现在这里直接 fetch(url),会连上回环服务
    await expect(
      deliverWebhook(`http://rebind.attacker.test:${port}/hook`, payload, {
        send: createGuardedSender({ allowAddress: publicOnly, resolve }),
        sleep: noSleep,
      }),
    ).rejects.toBeInstanceOf(WebhookTargetRejected);

    expect(calls).toBe(2); // 连接时确实重新解析,并校验了这一次的结果
    expect(hits).toEqual([]); // 关键:回环服务一个请求都没收到
  });

  it("任一解析结果落在禁止网段就拒绝(不挑一个看起来干净的连)", async () => {
    const resolve = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ];
    await expect(
      createGuardedSender({ allowAddress: publicOnly, resolve })(`http://mixed.test:${port}/hook`, {
        method: "POST",
        headers: {},
        body: "{}",
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(WebhookTargetRejected);
    expect(hits).toEqual([]);
  });

  it("IP 字面量不经过 DNS,同样被拦", async () => {
    await expect(
      createGuardedSender({ allowAddress: publicOnly })(`http://127.0.0.1:${port}/hook`, {
        method: "POST",
        headers: {},
        body: "{}",
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(WebhookTargetRejected);
    expect(hits).toEqual([]);
  });

  it("允许的地址:连接打到校验过的那个地址,Host 头仍是原始域名", async () => {
    const resolve = async () => [{ address: "127.0.0.1", family: 4 }];
    const r = await deliverWebhook(
      `http://hooks.partner.test:${port}/hook`,
      { ...payload, deliveryId: "t1" },
      {
        // 放开校验只是为了让请求落到本地测试服务上
        send: createGuardedSender({ allowAddress: () => true, resolve }),
        sleep: noSleep,
      },
    );
    expect(r.delivered).toBe(true);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.host).toBe(`hooks.partner.test:${port}`);
    expect(JSON.parse(hits[0]?.body ?? "{}")).toMatchObject({ taskId: "t1" });
  });

  it("不跟随重定向:302 当作失败,跳转目标收不到请求", async () => {
    const resolve = async () => [{ address: "127.0.0.1", family: 4 }];
    const r = await deliverWebhook(`http://hooks.partner.test:${port}/redirect`, payload, {
      send: createGuardedSender({ allowAddress: () => true, resolve }),
      sleep: noSleep,
      maxAttempts: 1,
    });
    expect(r).toMatchObject({ delivered: false, lastStatus: 302 });
    expect(hits.map((h) => h.url)).toEqual(["/redirect"]);
  });

  it("对方只发响应头、永不结束 body:拿到状态码就返回,连接随即释放", async () => {
    const resolve = async () => [{ address: "127.0.0.1", family: 4 }];
    const start = Date.now();
    const r = await deliverWebhook(`http://hooks.partner.test:${port}/hang`, payload, {
      send: createGuardedSender({ allowAddress: () => true, resolve }),
      sleep: noSleep,
      timeoutMs: 5_000,
    });
    expect(r).toMatchObject({ delivered: true, lastStatus: 200 });
    expect(Date.now() - start).toBeLessThan(2_000);

    // 关键:服务端那条连接要被平台主动关掉,而不是一直挂着等 body 结束
    expect(sockets).toHaveLength(1);
    const sock = sockets[0] as import("node:net").Socket;
    if (!sock.destroyed) {
      await Promise.race([
        new Promise((r) => sock.once("close", r)),
        new Promise((_, rej) => setTimeout(() => rej(new Error("连接没有被释放")), 1_000)),
      ]);
    }
    expect(sock.destroyed).toBe(true);
  });
});
