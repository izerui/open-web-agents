import { errorText, fetchJson } from "@/lib/fetch-json";
import { afterEach, describe, expect, it, vi } from "vitest";

function mockFetch(res: Partial<Response> & { jsonImpl?: () => Promise<unknown> }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: res.ok ?? true,
      status: res.status ?? 200,
      json: res.jsonImpl ?? (async () => ({})),
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchJson", () => {
  it("成功时返回解析后的 body", async () => {
    mockFetch({ ok: true, jsonImpl: async () => ({ sessions: [1, 2] }) });
    expect(await fetchJson<{ sessions: number[] }>("/x")).toEqual({ sessions: [1, 2] });
  });

  it("失败时优先抛服务端的 error 文案,而不是笼统的状态码", async () => {
    mockFetch({ ok: false, status: 401, jsonImpl: async () => ({ error: "login required" }) });
    await expect(fetchJson("/x")).rejects.toThrow("login required");
  });

  it("错误体不是 JSON 时退回状态码,而不是抛 SyntaxError", async () => {
    // 500 常常返回空体,原来的写法会在这里抛出令人费解的 "Unexpected end of JSON input"
    mockFetch({
      ok: false,
      status: 500,
      jsonImpl: async () => {
        throw new SyntaxError("Unexpected end of JSON input");
      },
    });
    await expect(fetchJson("/x")).rejects.toThrow("HTTP 500");
  });

  it("错误体是 JSON 但没有 error 字段时也退回状态码", async () => {
    mockFetch({ ok: false, status: 503, jsonImpl: async () => ({ foo: "bar" }) });
    await expect(fetchJson("/x")).rejects.toThrow("HTTP 503");
  });
});

describe("errorText", () => {
  it("Error 取 message", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
  });

  it("非 Error 也能转成可读文案", () => {
    expect(errorText("plain")).toBe("plain");
    expect(errorText(404)).toBe("404");
  });
});
