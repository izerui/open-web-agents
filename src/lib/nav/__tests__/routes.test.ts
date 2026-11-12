import { describe, expect, it } from "vitest";
import {
  agentHref,
  agentRoute,
  legacyRedirect,
  stageOfLegacyTab,
  meMenuItems,
  navFor,
  paletteEntries,
  spaceOf,
} from "../routes";

const go = (path: string, query = "") => legacyRedirect(path, new URLSearchParams(query));

describe("legacyRedirect:旧地址落到新位置并保留参数", () => {
  it.each([
    ["/", "session=s1", "/chat?session=s1"],
    ["/", "agent=a&session=s", "/chat?agent=a&session=s"],
    ["/", "agent=a", "/chat?agent=a"],
    ["/agents", "id=x", "/agents/x"],
    // 旧 Builder 的分区页签:评测、发布落到对应阶段,其余分区都在编排里
    ["/agents", "id=x&tab=eval", "/agents/x?stage=eval"],
    ["/agents", "id=x&tab=release", "/agents/x?stage=publish"],
    ["/agents", "id=x&tab=security", "/agents/x"],
    ["/agents", "id=x&tab=knowledge&foo=1", "/agents/x?foo=1"],
    ["/agents", "new=1", "/agents/new"],
    ["/settings/keys", "agent=x", "/agents/x?stage=access"],
    ["/settings/keys", "", "/developer/keys"],
    ["/settings/runs", "agent=x", "/agents/x?stage=runs"],
    ["/settings/runs", "", "/developer/runs"],
    ["/settings", "", "/account/security"],
    ["/settings/account", "", "/account/security"],
    ["/settings/credentials", "", "/account/prices"],
    ["/settings/billing", "", "/account/billing"],
    ["/settings/packages", "", "/account/billing?tab=packages"],
    ["/account/packages", "", "/account/billing?tab=packages"],
    ["/developer/keys", "agent=x", "/agents/x?stage=access"],
    ["/developer/keys", "agent=x&tab=docs", "/agents/x?tab=docs&stage=access"],
    ["/developer/runs", "agent=x", "/agents/x?stage=runs"],
    ["/settings/usage", "", "/account/usage"],
    ["/usage", "", "/account/usage"],
    ["/settings/audit", "", "/account/audit"],
    ["/market", "", "/"],
  ])("%s?%s → %s", (path, query, target) => {
    expect(go(path, query)).toBe(target);
  });

  it("不需要重定向的地址返回 null", () => {
    expect(go("/")).toBeNull();
    expect(go("/agents")).toBeNull();
    expect(go("/market/x")).toBeNull();
    expect(go("/chat", "session=s")).toBeNull();
    expect(go("/developer/keys")).toBeNull();
    expect(go("/developer/runs", "status=failed")).toBeNull();
    expect(go("/account/billing", "tab=packages")).toBeNull();
  });

  it("参数里的特殊字符原样带过去", () => {
    expect(go("/", "session=a%26b")).toBe("/chat?session=a%26b");
    expect(go("/agents", "id=%E6%8A%A5%E9%94%80")).toBe("/agents/%E6%8A%A5%E9%94%80");
  });
});

describe("spaceOf:当前页属于哪个一级空间", () => {
  it.each([
    ["/", "explore"],
    ["/market/x", "explore"],
    ["/chat", "chat"],
    ["/agents", "studio"],
    ["/agents/x", "studio"],
    ["/developer/runs", "developer"],
    ["/account/billing", "account"],
    ["/admin/models", "admin"],
  ])("%s → %s", (path, space) => {
    expect(spaceOf(path)).toBe(space);
  });
});

describe("navFor:按角色给出顶栏空间", () => {
  const user = { authenticated: true, user: { id: "u", email: "u@x", role: "user" } };
  const admin = { authenticated: true, user: { id: "a", email: "a@x", role: "admin" } };

  it("普通账号看不到管理", () => {
    expect(navFor(user).map((s) => s.key)).toEqual([
      "explore",
      "chat",
      "studio",
      "developer",
      "account",
    ]);
  });

  it("管理员多一个管理", () => {
    expect(navFor(admin).map((s) => s.key)).toContain("admin");
  });

  it("还没读到登录态时按普通账号处理", () => {
    expect(navFor(null).map((s) => s.key)).not.toContain("admin");
  });
});

describe("agentRoute / agentHref:构建页的地址", () => {
  it.each([
    ["/agents", { kind: "list" }],
    ["/agents/", { kind: "list" }],
    ["/agents/new", { kind: "new" }],
    ["/agents/expense-reviewer", { kind: "agent", id: "expense-reviewer" }],
    ["/agents/%E6%8A%A5%E9%94%80", { kind: "agent", id: "报销" }],
  ])("%s", (path, route) => {
    expect(agentRoute(path)).toEqual(route);
  });

  it("agentHref 生成可往返的地址", () => {
    expect(agentHref()).toBe("/agents");
    expect(agentHref({ isNew: true })).toBe("/agents/new");
    expect(agentHref({ id: "报销 a/b" })).toBe("/agents/%E6%8A%A5%E9%94%80%20a%2Fb");
    expect(agentRoute(agentHref({ id: "报销 a/b" }))).toEqual({ kind: "agent", id: "报销 a/b" });
    expect(agentHref({ id: "x", stage: "access" })).toBe("/agents/x?stage=access");
    expect(agentHref({ id: "x", designer: "s 1" })).toBe("/agents/x?designer=s%201");
    expect(agentHref({ isNew: true, designer: "s" })).toBe("/agents/new?designer=s");
    expect(agentHref({ id: "x", stage: "eval", designer: "s" })).toBe(
      "/agents/x?stage=eval&designer=s",
    );
  });

  it.each([
    ["eval", "eval"],
    ["release", "publish"],
    ["config", null],
    ["capabilities", null],
    ["knowledge", null],
    ["security", null],
    // 接入中心的页签:阶段由 stage 决定,tab 不再有意义
    ["keys", undefined],
    ["docs", undefined],
    ["webhook", undefined],
    ["", undefined],
  ])("stageOfLegacyTab(%s) = %s", (tab, stage) => {
    // null = 编排(去掉 stage);undefined = 不认识的页签,不改阶段
    expect(stageOfLegacyTab(tab)).toBe(stage);
  });
});

describe("meMenuItems:头像菜单", () => {
  const labels = (me: Parameters<typeof meMenuItems>[0]) => meMenuItems(me).map((i) => i.label);
  const user = {
    authenticated: true,
    authRequired: true,
    user: { id: "u", email: "u@x", role: "user" },
  };
  const admin = {
    authenticated: true,
    authRequired: true,
    user: { id: "a", email: "a@x", role: "admin" },
  };

  it("普通账号:积分、账号安全、操作日志、登出,没有平台管理", () => {
    expect(labels(user)).toEqual(["积分与套餐", "账号安全", "操作日志", "登出"]);
  });

  it("管理员多一项平台管理", () => {
    expect(labels(admin)).toEqual(["积分与套餐", "账号安全", "操作日志", "平台管理", "登出"]);
  });

  it("关闭登录的本地模式(接口真实返回 authenticated:false)给本地菜单,不是去登录,也没有登出", () => {
    const local = { authenticated: false, authRequired: false };
    expect(labels(local)).toEqual(["积分与套餐", "账号安全", "操作日志", "平台管理"]);
  });

  it("登录态还没读到(或读取失败)时不显示登出", () => {
    expect(labels(null)).not.toContain("登出");
  });

  it("未登录只有去登录", () => {
    expect(meMenuItems({ authenticated: false, authRequired: true })).toEqual([
      { label: "去登录", href: "/login" },
    ]);
  });

  it("登出是动作,其余是链接", () => {
    for (const item of meMenuItems(admin)) {
      if (item.label === "登出") expect(item.action).toBe("logout");
      else expect(item.href).toMatch(/^\//);
    }
  });
});

describe("paletteEntries:⌘K 里能跳的页面", () => {
  const user = { authenticated: true, user: { id: "u", email: "u@x", role: "user" } };
  const admin = { authenticated: true, user: { id: "a", email: "a@x", role: "admin" } };
  const hrefs = (me: Parameters<typeof paletteEntries>[0]) => paletteEntries(me).map((e) => e.href);

  it("普通账号能跳到所有个人页面,但没有管理页", () => {
    const h = hrefs(user);
    for (const p of [
      "/",
      "/chat",
      "/agents",
      "/agents/new",
      "/developer/keys",
      "/developer/runs",
      "/account/billing",
      "/account/usage",
      "/account/prices",
      "/account/security",
      "/account/audit",
    ]) {
      expect(h).toContain(p);
    }
    expect(h.some((x) => x.startsWith("/admin"))).toBe(false);
    // 充值与订单已并入「积分与套餐」的页签,不再单列
    expect(h).not.toContain("/account/packages");
  });

  it("管理员能跳到全部管理页", () => {
    expect(hrefs(admin)).toEqual(
      expect.arrayContaining(["/admin/accounts", "/admin/providers", "/admin/audit"]),
    );
  });

  it("侧栏页面名搜得到,空间名作为关键词也搜得到", () => {
    const keys = paletteEntries(user).find((e) => e.href === "/developer/keys");
    expect(keys?.label).toBe("API Key 与签名密钥");
    expect(keys?.keywords).toContain("开发者");
    const billing = paletteEntries(user).find((e) => e.href === "/account/billing");
    expect(billing?.label).toBe("积分与套餐");
    expect(billing?.keywords).toContain("账户");
    const accounts = paletteEntries(admin).find((e) => e.href === "/admin/accounts");
    expect(accounts?.label).toBe("账号");
    expect(accounts?.keywords).toContain("管理");
  });

  it("同一个地址只出现一次", () => {
    const h = hrefs(admin);
    expect(new Set(h).size).toBe(h.length);
  });
});
