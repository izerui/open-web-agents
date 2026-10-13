import {
  resolveCredentials,
  resolveModelAlias,
} from "@/lib/modules/agent-engine/domain/resolve-credentials";
import { describe, expect, it } from "vitest";

describe("resolveCredentials", () => {
  it("request > session > user > platform,各字段独立解析", () => {
    expect(
      resolveCredentials({
        platform: { baseUrl: "p", key: "pk" },
        user: { baseUrl: "u", key: "uk" },
        session: { baseUrl: "s" },
        request: { key: "rk" },
      }),
    ).toEqual({ baseUrl: "s", key: "rk" });
  });

  it("只有平台默认时用平台默认", () => {
    expect(resolveCredentials({ platform: { baseUrl: "p", key: "pk" } })).toEqual({
      baseUrl: "p",
      key: "pk",
    });
  });

  it("用户只覆盖 key,沿用平台网关 baseUrl", () => {
    expect(
      resolveCredentials({ platform: { baseUrl: "gw", key: "pk" }, user: { key: "uk" } }),
    ).toEqual({ baseUrl: "gw", key: "uk" });
  });

  it("空串视为未配置,继续向下回退", () => {
    expect(
      resolveCredentials({ platform: { baseUrl: "p", key: "pk" }, user: { key: "" } }),
    ).toEqual({ baseUrl: "p", key: "pk" });
  });

  // 【平台 key 外泄回归】baseUrl 与 key 曾经各自回退:只给自己的 baseUrl、不给 key,
  // 平台 key 就会被发到这个 baseUrl 上 —— 任何能填 baseUrl 的人都能把平台 key 引到自己的服务器
  it("自定义 baseUrl 而没给 key:拒绝,绝不把平台 key 发过去", () => {
    expect(() =>
      resolveCredentials({
        platform: { baseUrl: "https://gw", key: "pk" },
        request: { baseUrl: "https://attacker" },
      }),
    ).toThrow(/baseUrl/);
    expect(() =>
      resolveCredentials({
        platform: { baseUrl: "https://gw", key: "pk" },
        user: { baseUrl: "https://attacker" },
      }),
    ).toThrow(/baseUrl/);
  });

  it("自定义 baseUrl 也不能借用更低层(用户)的 key", () => {
    expect(() =>
      resolveCredentials({
        platform: { baseUrl: "gw", key: "pk" },
        user: { key: "uk" },
        request: { baseUrl: "https://elsewhere" },
      }),
    ).toThrow(/baseUrl/);
  });

  it("自定义 baseUrl 与同层 key 一起给:放行", () => {
    expect(
      resolveCredentials({
        platform: { baseUrl: "gw", key: "pk" },
        user: { baseUrl: "https://mine", key: "uk" },
      }),
    ).toEqual({ baseUrl: "https://mine", key: "uk" });
  });

  it("各级都缺 key 时抛错", () => {
    expect(() => resolveCredentials({ user: { baseUrl: "u" } })).toThrow(/key/i);
  });

  it("各级都缺 baseUrl 时抛错", () => {
    expect(() => resolveCredentials({ user: { key: "uk" } })).toThrow(/baseUrl/i);
  });
});

describe("resolveModelAlias", () => {
  it("都没设时用兜底", () => {
    expect(resolveModelAlias({}, "sonnet")).toBe("sonnet");
  });
  it("request 的模型最优先", () => {
    expect(
      resolveModelAlias({ session: { model: "opus" }, request: { model: "haiku" } }, "sonnet"),
    ).toBe("haiku");
  });
  it("只有 session 设了就用 session", () => {
    expect(resolveModelAlias({ session: { model: "opus" } }, "sonnet")).toBe("opus");
  });
});
