// 带地址守卫的 fetch:平台服务端替用户去连一个用户填的地址时用(MCP 测试连接)。
//
// 与 webhook 发送器同一套做法(见 guarded-http-sender.ts):地址检查接在建连自己的 DNS lookup 上,
// 被检查的地址就是被连接的地址,DNS 重绑定钻不了空子;不跟随重定向,3xx 原样返回。
// 和发送器不同的是要把响应体完整交出去(MCP 的响应是 JSON 或 SSE 流),所以返回标准 Response;
// 响应体设了上限,对方不能用一个无穷大的响应把服务端内存撑爆。

import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { defaultResolve, guardedLookup } from "./guarded-http-sender";

/** 地址不允许连接(回环、云元数据、未放行的内网等) */
export class AddressRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AddressRejected";
  }
}

export interface GuardedFetchOptions {
  allowAddress: (ip: string) => boolean;
  resolve?: (hostname: string) => Promise<{ address: string; family: number }[]>;
  /** 响应体上限(字节),默认 2MB */
  maxBodyBytes?: number;
}

export type GuardedFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const DEFAULT_MAX_BODY = 2 * 1024 * 1024;

function bodyText(body: RequestInit["body"]): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  throw new TypeError("guarded fetch 只支持字符串请求体");
}

/**
 * 响应体转成 Web 流,超过上限就报错并断开。
 * 不用 Readable.toWeb:调用方取消读取(MCP 客户端常对不需要的响应体 cancel)之后,它的适配层
 * 还会往已关闭的流里写数据,抛出无人接住的 ERR_INVALID_STATE,足以把进程打崩。这里自己管关闭状态
 */
function bodyStream(res: http.IncomingMessage, maxBody: number): ReadableStream<Uint8Array> {
  let closed = false;
  let seen = 0;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      res.on("data", (chunk: Buffer) => {
        if (closed) return;
        seen += chunk.length;
        if (seen > maxBody) {
          closed = true;
          controller.error(new Error(`响应超过 ${Math.round(maxBody / 1024)}KB 上限`));
          res.destroy();
          return;
        }
        controller.enqueue(new Uint8Array(chunk));
      });
      res.on("end", () => {
        if (closed) return;
        closed = true;
        controller.close();
      });
      res.on("error", (err) => {
        if (closed) return;
        closed = true;
        controller.error(err);
      });
    },
    cancel() {
      closed = true;
      res.destroy();
    },
  });
}

export function createGuardedFetch(opts: GuardedFetchOptions): GuardedFetch {
  const resolve = opts.resolve ?? defaultResolve;
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;

  return (input, init = {}) =>
    new Promise<Response>((resolvePromise, reject) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        reject(new AddressRejected(`只支持 http/https:${url.protocol}`));
        return;
      }
      const host = url.hostname.replace(/^\[|]$/g, "");
      // IP 字面量建连时不会经过 lookup,必须在这里查
      if (isIP(host) && !opts.allowAddress(host)) {
        reject(new AddressRejected(`不允许连接的地址:${host}`));
        return;
      }
      let rejected: AddressRejected | null = null;
      const lookup = guardedLookup({
        allowAddress: opts.allowAddress,
        resolve,
        reject: (hostname, bad) => {
          rejected = new AddressRejected(
            `${hostname} 解析到不允许连接的地址${bad ? `:${bad}` : "(无解析结果)"}`,
          );
          return rejected;
        },
      });
      let body: string | undefined;
      try {
        body = bodyText(init.body);
      } catch (err) {
        reject(err);
        return;
      }
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((v, k) => {
        headers[k] = v;
      });
      if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));

      const client = url.protocol === "https:" ? https : http;
      const req = client.request(
        url,
        {
          method: init.method ?? "GET",
          headers,
          lookup,
          signal: init.signal ?? undefined,
          // 不复用连接:keep-alive 池里的旧连接可能是之前解析出的地址,不经过本次校验
          agent: false,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const resHeaders = new Headers();
          for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
            resHeaders.append(res.rawHeaders[i] as string, res.rawHeaders[i + 1] as string);
          }
          const noBody = status === 204 || status === 304 || init.method === "HEAD";
          if (noBody) res.destroy();
          resolvePromise(
            new Response(noBody ? null : bodyStream(res, maxBody), {
              status: status < 200 || status > 599 ? 502 : status,
              statusText: res.statusMessage,
              headers: resHeaders,
            }),
          );
        },
      );
      req.on("error", (err) => reject(rejected ?? err));
      req.end(body);
    });
}
