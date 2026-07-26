import type { Grant, Subject } from "@/lib/modules/access/domain/grants";
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
const admin: Principal = { type: "web", userId: "root", role: "admin" };
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

  it("无归属的历史数据只对 admin 开放(否则开了登录就成跨用户泄露)", () => {
    expect(canAccessSession(admin, sess()).allowed).toBe(true);
    const d = canAccessSession(webA, sess());
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.reason).toMatch(/no owner/);
  });

  it("admin 也不能越权读别人【有明确归属】的会话", () => {
    expect(canAccessSession(admin, sess({ ownerId: "u1" })).allowed).toBe(false);
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

// 运行助手的授权。
//
// 这一组测试曾经把【越权当成规格】断言:"web 用户可调任意助手"、"未绑定的账户级 key
// 可调任意助手" —— 两条都是绿的,而它们描述的正是漏洞本身。真实后果:知道 assistantId
// 就能运行别人的私有助手,把对方的 systemPrompt 和知识库正文读出来;撤销分享无效。
//
// 所以下面刻意保留了"撤销分享后立刻失效"这条 —— 它是当初漏掉的那个场景。
describe("canInvokeAssistant", () => {
  const a1 = { id: "a1", ownerId: "u1" };
  const subj = (userId: string, role?: "admin" | "user"): Subject => ({ userId, role });
  const shareTo = (userId: string, permission: "read" | "write" = "read"): Grant[] => [
    {
      id: "g1",
      resourceType: "assistant",
      resourceId: "a1",
      principalType: "user",
      principalId: userId,
      permission,
    },
  ];

  it("owner 可以运行自己的助手", () => {
    expect(canInvokeAssistant(webA, a1, subj("u1"), []).allowed).toBe(true);
  });

  it("【越权回归】其他登录用户仅凭 id 不能运行他人私有助手", () => {
    const d = canInvokeAssistant(webB, a1, subj("u2"), []);
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.reason).toMatch(/no access/);
  });

  it("被分享后可以运行", () => {
    expect(canInvokeAssistant(webB, a1, subj("u2"), shareTo("u2")).allowed).toBe(true);
  });

  it("【撤销分享后立刻失效】—— 而不只是从列表里隐藏", () => {
    expect(canInvokeAssistant(webB, a1, subj("u2"), []).allowed).toBe(false);
  });

  it("admin 可以运行(助手是平台配置资产,需要能接管)", () => {
    expect(canInvokeAssistant(admin, a1, subj("root", "admin"), []).allowed).toBe(true);
  });

  it("【提权回归】账户级 key 只继承其归属用户的权限,不能靠签发 key 越权", () => {
    const keyOfU2: Principal = { type: "apiKey", keyId: "k9", ownerId: "u2" };
    expect(canInvokeAssistant(keyOfU2, a1, subj("u2"), []).allowed).toBe(false);
    expect(canInvokeAssistant(keyOfU2, a1, subj("u2"), shareTo("u2")).allowed).toBe(true);
  });

  it("未绑定的 key 在本账户内可调任意助手", () => {
    expect(canInvokeAssistant(keyA, a1, subj("u1"), []).allowed).toBe(true);
  });

  it("绑定了助手的 key 只能调那一个 —— 绑定先于授权判定", () => {
    expect(canInvokeAssistant(keyBound, a1, subj("u1"), []).allowed).toBe(true);
    const d = canInvokeAssistant(keyBound, { id: "a2", ownerId: "u1" }, subj("u1"), []);
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.reason).toMatch(/bound to another/);
  });

  it("绑定的 key 即便指向的助手已不再有权,也拒绝", () => {
    const bound: Principal = { type: "apiKey", keyId: "k4", ownerId: "u2", assistantId: "a1" };
    expect(canInvokeAssistant(bound, a1, subj("u2"), []).allowed).toBe(false);
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
