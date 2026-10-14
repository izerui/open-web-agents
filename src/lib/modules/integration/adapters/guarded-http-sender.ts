// 带地址守卫的 HTTP 发送器:webhook 的真实出站连接只走这里。
//
// 【为什么不能"先解析检查、再 fetch(url)"】那是两次独立的 DNS 解析:检查时域名解析到
// 公网地址,fetch 连接时再解析一次,攻击者控制的 DNS 这一次返回 127.0.0.1(DNS rebinding),
// 请求就打进了回环 / 内网,而检查早已"通过"。禁止重定向补不上这个窗口。
//
// 这里把检查接在【连接自己用的那次 lookup】上:node:http/https 建连时调用我们给的 lookup,
// 我们解析、逐个校验、再把同一批地址交回去 —— 被检查的地址就是被连接的地址,中间没有第二次解析。
// 请求仍以原始域名发出,所以 Host 头、TLS 的 SNI 与证书校验都照常针对域名进行,
// 不需要手工固定 IP 再自己处理 TLS。

import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { isIP } from "node:net";
import {
  type WebhookSender,
  WebhookTargetRejected,
} from "@/lib/modules/integration/application/webhook";

export interface GuardedSenderOptions {
  /** 地址是否允许连接。 */
  allowAddress: (ip: string) => boolean;
  /** 解析主机的全部地址。测试注入;默认走系统 DNS。 */
  resolve?: (hostname: string) => Promise<{ address: string; family: number }[]>;
}

const defaultResolve = (hostname: string) => dnsLookup(hostname, { all: true, verbatim: true });

export function createGuardedSender(opts: GuardedSenderOptions): WebhookSender {
  const resolve = opts.resolve ?? defaultResolve;

  return (rawUrl, init) =>
    new Promise((resolvePromise, reject) => {
      const url = new URL(rawUrl);
      const host = url.hostname.replace(/^\[|]$/g, "");
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        reject(new WebhookTargetRejected(`webhook 只支持 http/https:${url.protocol}`));
        return;
      }
      // IP 字面量建连时不会经过 lookup,必须在这里查
      if (isIP(host) && !opts.allowAddress(host)) {
        reject(new WebhookTargetRejected(`webhook 目标是不允许的地址:${host}`));
        return;
      }

      let rejected: WebhookTargetRejected | null = null;
      const lookup: LookupFunction = (hostname, options, callback) => {
        resolve(hostname)
          .then((addrs) => {
            const bad = addrs.find((a) => !opts.allowAddress(a.address));
            if (addrs.length === 0 || bad) {
              rejected = new WebhookTargetRejected(
                `webhook 目标 ${hostname} 解析到不允许的地址${bad ? `:${bad.address}` : "(无解析结果)"}`,
              );
              callback(rejected, "", 4);
              return;
            }
            // 把【刚校验过的这批地址】原样交给连接 —— 不再有第二次解析
            if (options.all) {
              callback(null, addrs);
            } else {
              const first = addrs[0] as { address: string; family: number };
              callback(null, first.address, first.family);
            }
          })
          .catch((err: NodeJS.ErrnoException) => callback(err, "", 4));
      };

      const client = url.protocol === "https:" ? https : http;
      const req = client.request(
        url,
        {
          method: init.method,
          headers: { ...init.headers, "Content-Length": Buffer.byteLength(init.body) },
          lookup,
          signal: init.signal,
          // 不复用连接:keep-alive 池里的旧连接可能是之前解析出的地址,不经过本次校验
          agent: false,
        },
        (res) => {
          // node:http 从不跟随重定向 —— 3xx 原样当作失败返回,不会被转进内网
          const status = res.statusCode ?? 0;
          // 只要状态码:拿到响应头就销毁响应与连接。曾经是 res.resume() 继续读响应体,
          // 而调用方此时已清掉超时 —— 对方只发响应头、永不结束 body,就能把连接一直占着。
          res.destroy();
          resolvePromise({ status, ok: status >= 200 && status < 300 });
        },
      );
      req.on("error", (err) => reject(rejected ?? err));
      req.end(init.body);
    });
}
