// Webhook 的目标地址策略与签名。纯规则,零 IO。
//
// 【为什么要限制目标地址】回调是平台服务端发起的 HTTP 请求,地址由智能体配置者填写。
// 不加限制,任何能建智能体的人都能让平台去打 127.0.0.1、169.254.169.254(云元数据)
// 或内网管理端口 —— 典型的服务端请求伪造(SSRF)。
//
// 【内网地址为什么是可选放行而不是一律禁止】这个平台是企业自托管的,
// "回调打到自家内网后端"是正当的主要用法。所以分两档:
//   - 永远禁止:回环、链路本地(含云元数据)、未指定、组播、保留段
//   - 默认禁止、可由部署方显式放行(OWA_WEBHOOK_ALLOW_PRIVATE=1):RFC1918 / CGNAT / IPv6 ULA

import { createHmac } from "node:crypto";
import { isIP } from "node:net";

export type AddressClass = "public" | "private" | "forbidden";

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inV4(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split("/") as [string, string];
  const bits = Number(bitsStr);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

const V4_FORBIDDEN = [
  "0.0.0.0/8",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
];
const V4_PRIVATE = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"];

/** 展开 IPv6 为 8 组 16 位整数。输入须已通过 isIP 校验。 */
function expandV6(ip: string): number[] {
  let addr = ip.toLowerCase();
  const zone = addr.indexOf("%");
  if (zone >= 0) addr = addr.slice(0, zone);
  // 末尾内嵌 IPv4(如 ::ffff:1.2.3.4)先换成两组十六进制
  const v4 = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4?.[1]) {
    const n = ipv4ToInt(v4[1]);
    addr = `${addr.slice(0, -v4[1].length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = addr.split("::") as [string, string | undefined];
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const fill = tail !== undefined ? new Array(8 - h.length - t.length).fill("0") : [];
  return [...h, ...fill, ...t].map((g) => Number.parseInt(g || "0", 16));
}

export function classifyAddress(ip: string): AddressClass {
  const family = isIP(ip);
  if (family === 4) {
    if (V4_FORBIDDEN.some((c) => inV4(ip, c))) return "forbidden";
    if (V4_PRIVATE.some((c) => inV4(ip, c))) return "private";
    return "public";
  }
  if (family === 6) {
    const g = expandV6(ip);
    const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
    // IPv4 映射 / 兼容地址:按内嵌的 IPv4 判定,否则 ::ffff:127.0.0.1 就绕过去了
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
      if (g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return "forbidden"; // :: 与 ::1
      return classifyAddress(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`);
    }
    if ((g0 & 0xffc0) === 0xfe80) return "forbidden"; // 链路本地
    if ((g0 & 0xff00) === 0xff00) return "forbidden"; // 组播
    if (g0 === 0x2001 && g1 === 0x0db8) return "forbidden"; // 文档段
    if ((g0 & 0xfe00) === 0xfc00) return "private"; // ULA
    return "public";
  }
  return "forbidden";
}

export function isAddressAllowed(ip: string, allowPrivate: boolean): boolean {
  const c = classifyAddress(ip);
  return c === "public" || (c === "private" && allowPrivate);
}

/**
 * 校验 webhook 地址本身(保存时调用)。只能看字面:域名的真实地址要在建连那一刻才确定,
 * 由 adapters/guarded-http-sender.ts 在连接自己的 DNS lookup 上检查。
 */
export function validateWebhookUrl(
  raw: string,
  opts: { allowPrivate: boolean },
): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "webhookUrl 不是合法的 URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "webhookUrl 只支持 http/https" };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "webhookUrl 不能内嵌账号密码,请改用签名校验来源" };
  }
  const host = url.hostname.replace(/^\[|]$/g, "");
  if (isIP(host)) {
    if (!isAddressAllowed(host, opts.allowPrivate)) {
      return { ok: false, reason: `webhookUrl 指向不允许的地址:${host}` };
    }
  } else if (host === "localhost" || host.endsWith(".localhost")) {
    return { ok: false, reason: "webhookUrl 不能指向 localhost" };
  }
  return { ok: true, url };
}

/** 签名头的取值:`v1=<hex(HMAC-SHA256(secret, "<timestamp>.<body>"))>`。 */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** 下一次投递的延迟。超过次数返回 null = 放弃。 */
const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 2 * 60 * 60_000];

export function nextWebhookDelay(attemptsSoFar: number): number | null {
  return RETRY_DELAYS_MS[attemptsSoFar - 1] ?? null;
}
