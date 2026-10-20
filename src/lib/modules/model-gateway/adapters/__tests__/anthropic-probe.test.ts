import { describe, expect, it, vi } from "vitest";
import { AnthropicHttpProbe } from "../anthropic-probe";

const input = { baseUrl: "https://gw.example", key: "sk-secret-1234", modelId: "m-1" };

describe("AnthropicHttpProbe", () => {
  it("按运行时同一路径发最小请求,不跟随重定向", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
    const r = await new AnthropicHttpProbe(fetchFn as unknown as typeof fetch).testAnthropic(input);
    expect(r).toMatchObject({ ok: true, status: 200, message: "连接成功" });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://gw.example/v1/messages");
    expect(init.redirect).toBe("manual");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("sk-secret-1234");
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "m-1", max_tokens: 1 });
  });

  it("上游错误信息里回显的 Key 被抹掉", async () => {
    const fetchFn = async () =>
      new Response(JSON.stringify({ error: { message: "invalid x-api-key: sk-secret-1234" } }), {
        status: 401,
      });
    const r = await new AnthropicHttpProbe(fetchFn as unknown as typeof fetch).testAnthropic(input);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.message).toBe("invalid x-api-key: ***");
  });

  it("重定向不跟随,提示填最终地址", async () => {
    const fetchFn = async () =>
      new Response(null, { status: 302, headers: { location: "https://x" } });
    const r = await new AnthropicHttpProbe(fetchFn as unknown as typeof fetch).testAnthropic(input);
    expect(r).toMatchObject({ ok: false, status: 302 });
    expect(r.message).toMatch(/重定向/);
  });

  it("连不上:返回失败说明,不抛出", async () => {
    const fetchFn = async () => {
      throw new Error("connect ECONNREFUSED sk-secret-1234");
    };
    const r = await new AnthropicHttpProbe(fetchFn as unknown as typeof fetch).testAnthropic(input);
    expect(r.ok).toBe(false);
    expect(r.status).toBeUndefined();
    expect(r.message).not.toContain("sk-secret");
  });
});
