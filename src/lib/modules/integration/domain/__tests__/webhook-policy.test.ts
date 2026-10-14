import { createHmac } from "node:crypto";
import {
  classifyAddress,
  nextWebhookDelay,
  signWebhook,
  validateWebhookUrl,
} from "@/lib/modules/integration/domain/webhook-policy";
import { describe, expect, it } from "vitest";

describe("classifyAddress", () => {
  it.each([
    ["127.0.0.1", "forbidden"],
    ["169.254.169.254", "forbidden"], // 云元数据
    ["0.0.0.0", "forbidden"],
    ["224.0.0.1", "forbidden"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["172.32.0.1", "public"],
    ["192.168.1.1", "private"],
    ["100.64.0.1", "private"],
    ["8.8.8.8", "public"],
    ["::1", "forbidden"],
    ["::", "forbidden"],
    ["fe80::1", "forbidden"],
    ["fd00::1", "private"],
    ["2606:4700::1111", "public"],
    // IPv4 映射地址不能成为绕过回环检查的后门
    ["::ffff:127.0.0.1", "forbidden"],
    ["::ffff:10.0.0.1", "private"],
    ["::ffff:7f00:1", "forbidden"],
    ["not-an-ip", "forbidden"],
  ])("%s → %s", (ip, cls) => {
    expect(classifyAddress(ip)).toBe(cls);
  });
});

describe("validateWebhookUrl", () => {
  const pub = { allowPrivate: false };
  it("公网 https 通过", () => {
    expect(validateWebhookUrl("https://hooks.example.com/x", pub).ok).toBe(true);
  });
  it.each([
    ["ftp://example.com/x", /http/],
    ["not a url", /合法/],
    ["https://user:pw@example.com/", /账号密码/],
    ["http://localhost:8080/", /localhost/],
    ["http://127.0.0.1/", /不允许/],
    ["http://[::1]/", /不允许/],
    ["http://169.254.169.254/latest/meta-data", /不允许/],
    ["http://10.0.0.5/hook", /不允许/],
  ])("%s 被拒", (url, reason) => {
    const v = validateWebhookUrl(url, pub);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(reason);
  });
  it("内网地址在显式放行后可用,回环仍然不行", () => {
    expect(validateWebhookUrl("http://10.0.0.5/hook", { allowPrivate: true }).ok).toBe(true);
    expect(validateWebhookUrl("http://127.0.0.1/", { allowPrivate: true }).ok).toBe(false);
  });
});

describe("signWebhook", () => {
  it("接收方能用同一个密钥按文档的算法验签", () => {
    const body = JSON.stringify({ taskId: "t1" });
    const sig = signWebhook("whsec_abc", 1700000000, body);
    const expected = createHmac("sha256", "whsec_abc").update(`1700000000.${body}`).digest("hex");
    expect(sig).toBe(`v1=${expected}`);
  });
  it("请求体或时间戳被改,签名就对不上", () => {
    const a = signWebhook("k", 1, '{"a":1}');
    expect(signWebhook("k", 1, '{"a":2}')).not.toBe(a);
    expect(signWebhook("k", 2, '{"a":1}')).not.toBe(a);
  });
});

describe("nextWebhookDelay", () => {
  it("按退避表递增,用完放弃", () => {
    expect(nextWebhookDelay(1)).toBe(30_000);
    expect(nextWebhookDelay(5)).toBe(2 * 60 * 60_000);
    expect(nextWebhookDelay(6)).toBeNull();
  });
});
