// 带地址守卫的 fetch:IP 字面量与解析结果都校验(请求根本发不出去),不跟随重定向,
// 响应体有上限,调用方取消读取后不会再往流里写(曾经用 Readable.toWeb 时会抛出无人接住的异常)。
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AddressRejected, createGuardedFetch } from "../guarded-fetch";

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
});
async function listen(handler: http.RequestListener) {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
const open = createGuardedFetch({ allowAddress: () => true });

describe("createGuardedFetch", () => {
  it("请求方法、头、体照常发出,响应状态、头、体照常返回", async () => {
    const base = await listen(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      res
        .writeHead(201, { "x-echo": String(req.headers["x-test"]) })
        .end(`${req.method}:${Buffer.concat(chunks).toString()}`);
    });
    const r = await open(`${base}/p`, { method: "POST", headers: { "x-test": "1" }, body: "hi" });
    expect(r.status).toBe(201);
    expect(r.headers.get("x-echo")).toBe("1");
    expect(await r.text()).toBe("POST:hi");
  });

  it("不允许的地址:IP 字面量与解析结果都拒绝,对方收不到请求", async () => {
    let hits = 0;
    const base = await listen((_q, s) => {
      hits += 1;
      s.end();
    });
    const deny = createGuardedFetch({ allowAddress: () => false });
    await expect(deny(`${base}/`)).rejects.toBeInstanceOf(AddressRejected);
    const port = new URL(base).port;
    const rebound = createGuardedFetch({
      allowAddress: (ip) => ip !== "127.0.0.1",
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    await expect(rebound(`http://evil.example.test:${port}/`)).rejects.toBeInstanceOf(
      AddressRejected,
    );
    await expect(deny("file:///etc/passwd")).rejects.toBeInstanceOf(AddressRejected);
    expect(hits).toBe(0);
  });

  it("不跟随重定向:3xx 原样返回", async () => {
    const base = await listen((_q, s) =>
      s.writeHead(302, { location: "http://127.0.0.1:1/" }).end(),
    );
    const r = await open(`${base}/`);
    expect(r.status).toBe(302);
  });

  it("响应体超过上限:读取时报错", async () => {
    const base = await listen((_q, s) => s.end("x".repeat(5000)));
    const small = createGuardedFetch({ allowAddress: () => true, maxBodyBytes: 1000 });
    const r = await small(`${base}/`);
    await expect(r.text()).rejects.toThrow(/上限/);
  });

  it("取消读取后对方继续发送:不再写入、断开连接,没有未处理的异常", async () => {
    let closed = false;
    const base = await listen((req, s) => {
      s.writeHead(200);
      const t = setInterval(() => s.write("chunk"), 5);
      req.socket.on("close", () => {
        closed = true;
        clearInterval(t);
      });
    });
    const errors: unknown[] = [];
    const onErr = (e: unknown) => errors.push(e);
    process.on("uncaughtException", onErr);
    try {
      const r = await open(`${base}/`);
      const reader = r.body?.getReader();
      await reader?.read();
      await reader?.cancel();
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      process.off("uncaughtException", onErr);
    }
    expect(errors).toEqual([]);
    expect(closed).toBe(true);
  });
});
