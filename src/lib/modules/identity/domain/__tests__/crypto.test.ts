import { hashPassword, verifyPassword } from "@/lib/modules/identity/domain/password";
import { SecretBox, maskSecret } from "@/lib/modules/identity/domain/secret-box";
import {
  SESSION_COOKIE,
  buildClearCookie,
  buildSessionCookie,
  issueToken,
  readSessionCookie,
  verifyToken,
} from "@/lib/modules/identity/domain/session-token";
import { describe, expect, it } from "vitest";

describe("password", () => {
  it("正确密码校验通过", async () => {
    const h = await hashPassword("s3cret-pass");
    expect(await verifyPassword("s3cret-pass", h)).toBe(true);
  });

  it("错误密码不通过", async () => {
    const h = await hashPassword("s3cret-pass");
    expect(await verifyPassword("wrong", h)).toBe(false);
  });

  it("同一密码两次哈希不同(加盐)", async () => {
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  });

  it("哈希里不含明文", async () => {
    expect(await hashPassword("plaintextpw")).not.toContain("plaintextpw");
  });

  it("参数随哈希一起存,便于将来调参不失效", async () => {
    expect(await hashPassword("x")).toMatch(/^scrypt\$\d+\$\d+\$\d+\$/);
  });

  it("空密码不允许", async () => {
    await expect(hashPassword("")).rejects.toThrow();
    expect(await verifyPassword("", "whatever")).toBe(false);
  });

  it("损坏/伪造的哈希记录一律判否,绝不放行", async () => {
    expect(await verifyPassword("x", "garbage")).toBe(false);
    expect(await verifyPassword("x", "scrypt$1$1$1$$")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$1$1$1$aa$bb")).toBe(false);
    expect(await verifyPassword("x", "scrypt$NaN$8$1$aa$bb")).toBe(false);
  });

  it("Unicode 密码可用", async () => {
    const h = await hashPassword("密码🔐测试");
    expect(await verifyPassword("密码🔐测试", h)).toBe(true);
    expect(await verifyPassword("密码测试", h)).toBe(false);
  });
});

describe("SecretBox", () => {
  const box = new SecretBox("master-key-abc");

  it("加密后可解回原文", () => {
    expect(box.decrypt(box.encrypt("sk-user-key"))).toBe("sk-user-key");
  });

  it("同一明文两次密文不同(随机 IV)", () => {
    expect(box.encrypt("same")).not.toBe(box.encrypt("same"));
  });

  it("密文里不含明文", () => {
    expect(box.encrypt("sk-visible")).not.toContain("sk-visible");
  });

  it("换主密钥解不开(不会静默产出垃圾)", () => {
    const other = new SecretBox("different-master");
    expect(other.decrypt(box.encrypt("secret"))).toBeNull();
  });

  it("密文被篡改则解密失败(GCM 完整性校验)", () => {
    const enc = box.encrypt("secret");
    const parts = enc.split("$");
    const tampered = `${parts[0]}$${parts[1]}$${parts[2]}$${Buffer.from("hacked").toString("base64")}`;
    expect(box.decrypt(tampered)).toBeNull();
  });

  it("格式非法返回 null", () => {
    expect(box.decrypt("garbage")).toBeNull();
    expect(box.decrypt("v2$a$b$c")).toBeNull();
  });

  it("空主密钥不允许", () => {
    expect(() => new SecretBox("")).toThrow();
  });

  it("空串与 Unicode 都能往返", () => {
    expect(box.decrypt(box.encrypt(""))).toBe("");
    expect(box.decrypt(box.encrypt("密钥🔑"))).toBe("密钥🔑");
  });
});

describe("maskSecret", () => {
  it("只露尾部若干位", () => {
    expect(maskSecret("sk-abcdefghij")).toBe("********ghij");
  });
  it("过短的密钥全遮", () => {
    expect(maskSecret("abc")).toBe("***");
  });
  it("空串返回空", () => {
    expect(maskSecret("")).toBe("");
  });
});

describe("session token", () => {
  const S = "session-secret";

  it("签发的 token 可校验并解出 userId", () => {
    const t = issueToken(S, "u1", 60_000, 1000);
    expect(verifyToken(S, t, 2000)).toEqual({ userId: "u1", expiresAt: 61_000 });
  });

  it("换密钥验不过(防伪造)", () => {
    const t = issueToken(S, "u1", 60_000, 1000);
    expect(verifyToken("other-secret", t, 2000)).toBeNull();
  });

  it("过期即无效", () => {
    const t = issueToken(S, "u1", 1000, 1000);
    expect(verifyToken(S, t, 5000)).toBeNull();
  });

  it("篡改 userId 验不过", () => {
    const t = issueToken(S, "u1", 60_000, 1000);
    const forged = t.replace("u1.", "admin.");
    expect(verifyToken(S, forged, 2000)).toBeNull();
  });

  it("篡改过期时间以延长有效期,验不过", () => {
    const t = issueToken(S, "u1", 1000, 1000);
    const [uid, , sig] = t.split(".");
    expect(verifyToken(S, `${uid}.99999999999.${sig}`, 5000)).toBeNull();
  });

  it("格式垃圾一律返回 null,不抛错", () => {
    expect(verifyToken(S, "")).toBeNull();
    expect(verifyToken(S, "nodots")).toBeNull();
    expect(verifyToken(S, ".a.b")).toBeNull();
    expect(verifyToken("", "a.b.c")).toBeNull();
  });

  it("userId 含点会被拒(避免解析歧义)", () => {
    expect(() => issueToken(S, "a.b", 1000)).toThrow();
  });
});

describe("session cookie", () => {
  it("从 Cookie 头取出令牌", () => {
    expect(readSessionCookie(`${SESSION_COOKIE}=abc.def.ghi`)).toBe("abc.def.ghi");
  });
  it("多个 cookie 里也能取对", () => {
    expect(readSessionCookie(`other=1; ${SESSION_COOKIE}=tok; more=2`)).toBe("tok");
  });
  it("没有该 cookie 返回 null", () => {
    expect(readSessionCookie("other=1")).toBeNull();
    expect(readSessionCookie(null)).toBeNull();
    expect(readSessionCookie(`${SESSION_COOKIE}=`)).toBeNull();
  });

  it("Set-Cookie 带 HttpOnly/SameSite 防 XSS 窃取与基本 CSRF", () => {
    const c = buildSessionCookie("tok", 60_000, false);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Max-Age=60");
    expect(c).not.toContain("Secure");
  });

  it("生产环境加 Secure", () => {
    expect(buildSessionCookie("tok", 1000, true)).toContain("Secure");
  });

  it("登出用的清除 cookie 立即过期", () => {
    expect(buildClearCookie(false)).toContain("Max-Age=0");
  });
});
