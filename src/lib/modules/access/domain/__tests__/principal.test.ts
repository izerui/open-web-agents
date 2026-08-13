import type { Grant, Subject } from "@/lib/modules/access/domain/grants";
import {
  type Principal,
  type SessionOwnership,
  canAccessSession,
  canAdministerPlatform,
  canInvokeAgent,
  canManageAgents,
} from "@/lib/modules/access/domain/principal";
import { describe, expect, it } from "vitest";

const webA: Principal = { type: "web", userId: "u1" };
const webB: Principal = { type: "web", userId: "u2" };
const admin: Principal = { type: "web", userId: "root", role: "admin" };
const keyA: Principal = { type: "apiKey", keyId: "k1", ownerId: "u1" };
const keyB: Principal = { type: "apiKey", keyId: "k2", ownerId: "u1" };
const keyBound: Principal = { type: "apiKey", keyId: "k3", ownerId: "u1", agentId: "a1" };

const sess = (over: Partial<SessionOwnership> = {}): SessionOwnership => ({
  id: "s1",
  agentId: "a1",
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

  it("读不到另一个调用方发起的会话(即便同一智能体)", () => {
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

// 运行智能体的授权。
//
// 这一组测试曾经把【越权当成规格】断言:"web 用户可调任意智能体"、"未绑定的账户级 key
// 可调任意智能体" —— 两条都是绿的,而它们描述的正是漏洞本身。真实后果:知道 agentId
// 就能运行别人的私有智能体,把对方的 systemPrompt 和知识库正文读出来;撤销分享无效。
//
// 所以下面刻意保留了"撤销分享后立刻失效"这条 —— 它是当初漏掉的那个场景。
describe("canInvokeAgent", () => {
  const a1 = { id: "a1", ownerId: "u1" };
  const subj = (userId: string, role?: "admin" | "user"): Subject => ({ userId, role });
  const shareTo = (userId: string, permission: "read" | "write" = "read"): Grant[] => [
    {
      id: "g1",
      resourceType: "agent",
      resourceId: "a1",
      principalType: "user",
      principalId: userId,
      permission,
    },
  ];

  it("owner 可以运行自己的智能体", () => {
    expect(canInvokeAgent(webA, a1, subj("u1"), []).allowed).toBe(true);
  });

  it("【越权回归】其他登录用户仅凭 id 不能运行他人私有智能体", () => {
    const d = canInvokeAgent(webB, a1, subj("u2"), []);
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.reason).toMatch(/no access/);
  });

  it("被分享后可以运行", () => {
    expect(canInvokeAgent(webB, a1, subj("u2"), shareTo("u2")).allowed).toBe(true);
  });

  it("【撤销分享后立刻失效】—— 而不只是从列表里隐藏", () => {
    expect(canInvokeAgent(webB, a1, subj("u2"), []).allowed).toBe(false);
  });

  it("admin 可以运行(智能体是平台配置资产,需要能接管)", () => {
    expect(canInvokeAgent(admin, a1, subj("root", "admin"), []).allowed).toBe(true);
  });

  it("【提权回归】账户级 key 只继承其归属用户的权限,不能靠签发 key 越权", () => {
    const keyOfU2: Principal = { type: "apiKey", keyId: "k9", ownerId: "u2" };
    expect(canInvokeAgent(keyOfU2, a1, subj("u2"), []).allowed).toBe(false);
    expect(canInvokeAgent(keyOfU2, a1, subj("u2"), shareTo("u2")).allowed).toBe(true);
  });

  it("未绑定的 key 在本账户内可调任意智能体", () => {
    expect(canInvokeAgent(keyA, a1, subj("u1"), []).allowed).toBe(true);
  });

  it("绑定了智能体的 key 只能调那一个 —— 绑定先于授权判定", () => {
    expect(canInvokeAgent(keyBound, a1, subj("u1"), []).allowed).toBe(true);
    const d = canInvokeAgent(keyBound, { id: "a2", ownerId: "u1" }, subj("u1"), []);
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.reason).toMatch(/bound to another/);
  });

  it("绑定的 key 即便指向的智能体已不再有权,也拒绝", () => {
    const bound: Principal = { type: "apiKey", keyId: "k4", ownerId: "u2", agentId: "a1" };
    expect(canInvokeAgent(bound, a1, subj("u2"), []).allowed).toBe(false);
  });
});

describe("canManageAgents", () => {
  it("web 用户可管理智能体", () => {
    expect(canManageAgents(webA).allowed).toBe(true);
  });
  it("对外 key 不能改智能体定义(防调用方篡改提示词)", () => {
    expect(canManageAgents(keyA).allowed).toBe(false);
    expect(canManageAgents(keyBound).allowed).toBe(false);
  });
});

describe("canAdministerPlatform", () => {
  it("管理员放行", () => {
    expect(canAdministerPlatform({ type: "web", userId: "u1", role: "admin" }).allowed).toBe(true);
  });

  it("普通用户拒绝", () => {
    expect(canAdministerPlatform({ type: "web", userId: "u1", role: "user" }).allowed).toBe(false);
  });

  it("没写 role 的 web 主体也拒绝 —— 缺省不能等于放行", () => {
    expect(canAdministerPlatform({ type: "web", userId: "u1" }).allowed).toBe(false);
  });

  it("对外 key 一律拒绝 —— 哪怕签发它的人是管理员", () => {
    /*
     * 【为什么这条必须有】key 会躺在第三方的服务器配置里。
     * Principal 里 apiKey 分支根本没有 role 字段(类型上就断了继承的可能),
     * 但判定函数仍要显式拒绝:将来若有人给 apiKey 补上 role,
     * 这条测试会立刻挡住"key 顺带继承管理权"这个变化。
     */
    expect(canAdministerPlatform({ type: "apiKey", keyId: "k1", ownerId: "u1" }).allowed).toBe(
      false,
    );
  });
});
