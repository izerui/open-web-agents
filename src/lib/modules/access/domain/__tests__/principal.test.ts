import {
  type Principal,
  type SessionOwnership,
  canAccessSession,
  canInvokeAssistant,
  canManageAssistants,
} from "@/lib/modules/access/domain/principal";
import { describe, expect, it } from "vitest";

const webA: Principal = { type: "web", userId: "u1" };
const webB: Principal = { type: "web", userId: "u2" };
const keyA: Principal = { type: "apiKey", keyId: "k1", ownerId: "u1" };
const keyB: Principal = { type: "apiKey", keyId: "k2", ownerId: "u1" };
const keyBound: Principal = { type: "apiKey", keyId: "k3", ownerId: "u1", assistantId: "a1" };

const sess = (over: Partial<SessionOwnership> = {}): SessionOwnership => ({
  id: "s1",
  assistantId: "a1",
  ...over,
});

describe("canAccessSession / web 用户", () => {
  it("能读自己的会话", () => {
    expect(canAccessSession(webA, sess({ ownerId: "u1" })).allowed).toBe(true);
  });

  it("读不到别人的会话", () => {
    const d = canAccessSession(webB, sess({ ownerId: "u1" }));
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.reason).toMatch(/another user/);
  });

  it("无归属的历史会话放行(兼容单用户时期的旧数据)", () => {
    expect(canAccessSession(webA, sess()).allowed).toBe(true);
  });
});

describe("canAccessSession / API Key", () => {
  it("能读自己发起的会话", () => {
    expect(canAccessSession(keyA, sess({ callerApiKeyId: "k1" })).allowed).toBe(true);
  });

  it("读不到另一个调用方发起的会话(即便同一助手)", () => {
    const d = canAccessSession(keyB, sess({ callerApiKeyId: "k1" }));
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.reason).toMatch(/another caller/);
  });

  it("读不到人类用户在网页创建的会话", () => {
    expect(canAccessSession(keyA, sess({ ownerId: "u1" })).allowed).toBe(false);
  });

  it("无归属的会话对 API Key 一律拒绝(不沿用 web 的宽松兼容)", () => {
    expect(canAccessSession(keyA, sess()).allowed).toBe(false);
  });
});

describe("canInvokeAssistant", () => {
  it("web 用户可调任意助手", () => {
    expect(canInvokeAssistant(webA, "any").allowed).toBe(true);
  });
  it("未绑定的账户级 key 可调任意助手", () => {
    expect(canInvokeAssistant(keyA, "a9").allowed).toBe(true);
  });
  it("绑定了助手的 key 只能调那一个", () => {
    expect(canInvokeAssistant(keyBound, "a1").allowed).toBe(true);
    const d = canInvokeAssistant(keyBound, "a2");
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.reason).toMatch(/bound to another/);
  });
});

describe("canManageAssistants", () => {
  it("web 用户可管理助手", () => {
    expect(canManageAssistants(webA).allowed).toBe(true);
  });
  it("对外 key 不能改助手定义(防调用方篡改提示词)", () => {
    expect(canManageAssistants(keyA).allowed).toBe(false);
    expect(canManageAssistants(keyBound).allowed).toBe(false);
  });
});
