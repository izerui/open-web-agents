import {
  extractEmbedToken,
  issueEmbedToken,
  verifyEmbedToken,
} from "@/lib/modules/integration/domain/embed-token";
import { describe, expect, it } from "vitest";

const S = "embed-secret";
const claims = { assistantId: "a1", sessionId: "s1", keyId: "k1" };

describe("issueEmbedToken / verifyEmbedToken", () => {
  it("签发的令牌可校验并解出全部声明", () => {
    const t = issueEmbedToken(S, claims, 60_000, 1000);
    expect(verifyEmbedToken(S, t, 2000)).toEqual({ ...claims, expiresAt: 61_000 });
  });

  it("令牌里不含 API Key 明文 —— 浏览器永远拿不到 key", () => {
    const t = issueEmbedToken(S, claims, 60_000);
    expect(t).not.toContain("owa_");
    // 只带 keyId 供审计,不带密钥本身
    const decoded = verifyEmbedToken(S, t);
    expect(decoded?.keyId).toBe("k1");
  });

  it("换密钥验不过(防伪造)", () => {
    const t = issueEmbedToken(S, claims, 60_000, 1000);
    expect(verifyEmbedToken("other", t, 2000)).toBeNull();
  });

  it("过期即无效 —— 泄露后的爆炸半径被时间限死", () => {
    const t = issueEmbedToken(S, claims, 1000, 1000);
    expect(verifyEmbedToken(S, t, 5000)).toBeNull();
  });

  it("篡改 payload 换个会话,验不过", () => {
    const t = issueEmbedToken(S, claims, 60_000, 1000);
    const forged = Buffer.from(
      JSON.stringify({ ...claims, sessionId: "victim", expiresAt: 61_000 }),
      "utf8",
    ).toString("base64url");
    const [v, , sig] = t.split(".");
    expect(verifyEmbedToken(S, `${v}.${forged}.${sig}`, 2000)).toBeNull();
  });

  it("篡改过期时间以延长有效期,验不过", () => {
    const t = issueEmbedToken(S, claims, 1000, 1000);
    const forged = Buffer.from(
      JSON.stringify({ ...claims, expiresAt: 99_999_999_999 }),
      "utf8",
    ).toString("base64url");
    const [v, , sig] = t.split(".");
    expect(verifyEmbedToken(S, `${v}.${forged}.${sig}`, 5000)).toBeNull();
  });

  it("格式垃圾一律 null,不抛错", () => {
    expect(verifyEmbedToken(S, "")).toBeNull();
    expect(verifyEmbedToken(S, "nodots")).toBeNull();
    expect(verifyEmbedToken(S, "v2.a.b")).toBeNull();
    expect(verifyEmbedToken(S, "v1..sig")).toBeNull();
    expect(verifyEmbedToken("", "v1.a.b")).toBeNull();
  });

  it("payload 不是合法 JSON 时安全返回 null", () => {
    const bad = Buffer.from("not json", "utf8").toString("base64url");
    // 用正确密钥签一个坏 payload,确保是"解析失败"而非"签名失败"路径
    const t = `v1.${bad}.${issueEmbedToken(S, claims, 1000).split(".")[2]}`;
    expect(verifyEmbedToken(S, t)).toBeNull();
  });

  it("缺必要声明的令牌无效", () => {
    const t = issueEmbedToken(S, { assistantId: "", sessionId: "s1", keyId: "k1" }, 60_000);
    expect(verifyEmbedToken(S, t)).toBeNull();
  });

  it("空密钥或非正 TTL 不允许签发", () => {
    expect(() => issueEmbedToken("", claims, 1000)).toThrow();
    expect(() => issueEmbedToken(S, claims, 0)).toThrow();
  });
});

function headersOf(map: Record<string, string>) {
  return { get: (n: string) => map[n.toLowerCase()] ?? null };
}

describe("extractEmbedToken", () => {
  it("从 X-Embed-Token 取", () => {
    expect(extractEmbedToken(headersOf({ "x-embed-token": "v1.a.b" }))).toBe("v1.a.b");
  });
  it("去空白", () => {
    expect(extractEmbedToken(headersOf({ "x-embed-token": "  t  " }))).toBe("t");
  });
  it("没有则 null", () => {
    expect(extractEmbedToken(headersOf({}))).toBeNull();
    expect(extractEmbedToken(headersOf({ "x-embed-token": "  " }))).toBeNull();
  });
  it("不误取 API Key 头 —— 两种凭证严格分开", () => {
    expect(extractEmbedToken(headersOf({ "x-api-key": "owa_secret" }))).toBeNull();
  });
});
