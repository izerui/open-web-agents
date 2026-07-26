import {
  KEY_PREFIX,
  extractApiKey,
  generateApiKey,
  hashApiKey,
  looksLikeApiKey,
  safeEqualHash,
} from "@/lib/modules/identity/domain/api-key";
import { describe, expect, it } from "vitest";

describe("generateApiKey", () => {
  it("带平台前缀,便于日志里识别", () => {
    expect(generateApiKey().startsWith(KEY_PREFIX)).toBe(true);
  });

  it("每次都不同(足够熵)", () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateApiKey()));
    expect(keys.size).toBe(50);
  });

  it("长度足以抗暴力枚举", () => {
    expect(generateApiKey().length).toBeGreaterThan(40);
  });

  it("只含 URL 安全字符,不需转义", () => {
    expect(generateApiKey().slice(KEY_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("hashApiKey", () => {
  it("同一明文哈希稳定", () => {
    expect(hashApiKey("owa_abc")).toBe(hashApiKey("owa_abc"));
  });

  it("不同明文哈希不同", () => {
    expect(hashApiKey("owa_a")).not.toBe(hashApiKey("owa_b"));
  });

  it("输出 64 位 hex(SHA-256)", () => {
    expect(hashApiKey("x")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("哈希里不含明文,库泄露也拿不到可用密钥", () => {
    const plain = generateApiKey();
    expect(hashApiKey(plain)).not.toContain(plain.slice(KEY_PREFIX.length, 20));
  });
});

describe("looksLikeApiKey", () => {
  it("接受真实生成的密钥", () => {
    expect(looksLikeApiKey(generateApiKey())).toBe(true);
  });
  it("拒绝无前缀与过短的输入", () => {
    expect(looksLikeApiKey("abc")).toBe(false);
    expect(looksLikeApiKey("owa_short")).toBe(false);
    expect(looksLikeApiKey("")).toBe(false);
  });
});

describe("safeEqualHash", () => {
  it("相同哈希判等", () => {
    const h = hashApiKey("k");
    expect(safeEqualHash(h, h)).toBe(true);
  });
  it("不同哈希判否", () => {
    expect(safeEqualHash(hashApiKey("a"), hashApiKey("b"))).toBe(false);
  });
  it("长度不同不抛错,直接判否", () => {
    expect(safeEqualHash("abc", "abcdef")).toBe(false);
  });
  it("空串不炸", () => {
    expect(safeEqualHash("", "")).toBe(true);
  });
});

function headersOf(map: Record<string, string>) {
  return { get: (n: string) => map[n.toLowerCase()] ?? null };
}

describe("extractApiKey", () => {
  it("从 X-Api-Key 取", () => {
    expect(extractApiKey(headersOf({ "x-api-key": "owa_k" }))).toBe("owa_k");
  });
  it("从 Authorization Bearer 取", () => {
    expect(extractApiKey(headersOf({ authorization: "Bearer owa_k" }))).toBe("owa_k");
  });
  it("Bearer 大小写不敏感", () => {
    expect(extractApiKey(headersOf({ authorization: "bearer owa_k" }))).toBe("owa_k");
  });
  it("X-Api-Key 优先于 Authorization", () => {
    expect(extractApiKey(headersOf({ "x-api-key": "owa_a", authorization: "Bearer owa_b" }))).toBe(
      "owa_a",
    );
  });
  it("去掉首尾空白", () => {
    expect(extractApiKey(headersOf({ "x-api-key": "  owa_k  " }))).toBe("owa_k");
  });
  it("都没有时返回 null", () => {
    expect(extractApiKey(headersOf({}))).toBeNull();
    expect(extractApiKey(headersOf({ "x-api-key": "   " }))).toBeNull();
    expect(extractApiKey(headersOf({ authorization: "Basic xyz" }))).toBeNull();
  });
});
