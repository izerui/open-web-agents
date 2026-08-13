// 管理员区边界的端到端回归。
//
// 【为什么必须是端到端】设置区侧栏对非管理员不渲染「平台管理」分组,
// 用户菜单里也没有那一项 —— 但那只是"不摆在眼前"。地址栏里手敲
// /admin/usage 一样会打到服务端。这道守卫写在 page 组件里(server-guard.ts),
// 单测碰不到它:它依赖真实的 cookie 解析、真实的 role、以及 Next 的 redirect。
//
// 同样重要的是 scope 的降级:普通用户带上 ?scope=all 时,接口必须
// 【静默降级成只看自己】而不是放行,也不是报错。这条规则一旦写反
// (比如 `wantAll || isAdmin`),全平台数据就对所有人敞开了。

import { beforeAll, describe, expect, it } from "vitest";
import { BASE, type Client, newUser, serverUp } from "./client";

type GroupsRes = { groups?: { id: string; name: string }[]; scope?: string; canViewAll?: boolean };
type UsageRes = { scope?: string; canViewAll?: boolean };
type GroupRes = { group?: { id: string } };

/**
 * 跟随重定向前先看一眼落点。
 * fetch 默认会跟着跳,那样就分不清"被守卫弹回工作台"和"页面本来就长这样"。
 */
async function landing(client: Client, path: string) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Cookie: client.cookieHeader() },
    redirect: "manual",
  });
  return { status: res.status, location: res.headers.get("location") };
}

describe("管理员区边界", () => {
  let member: Client;
  /**
   * 管理员对照组。
   *
   * 【为什么可能拿不到】role 只在注册时定:库里【第一个】用户才是 admin,
   * 且没有任何接口能改 role。所以只有对着全新库跑,这里才拿得到管理员;
   * 重复跑同一个库时第一个用户早就存在了,拿不到它的密码。
   *
   * 拿不到就明确 skip 掉正向用例,而不是让它悄悄不跑 ——
   * 一套"拒绝一切"的测试也能全绿,那种绿是没有意义的。
   */
  let admin: Client | null = null;

  beforeAll(async () => {
    if (!(await serverUp())) {
      throw new Error("e2e 需要一个跑着的服务。用 `pnpm test:e2e`(自动起停)。");
    }

    const first = await newUser("admin");
    const firstMe = await first.get<{ user?: { role?: string } }>("/api/auth");
    if (firstMe.body.user?.role === "admin") admin = first;

    // 上面那个占掉了"第一个用户"的位置,这个必定是普通用户
    member = await newUser("member");
    const me = await member.get<{ user?: { role?: string } }>("/api/auth");
    expect(me.body.user?.role).toBe("user");
  });

  it("管理员能进 /admin/usage(对照组 —— 防止全靠拒绝拿满分)", async (ctx) => {
    if (!admin) ctx.skip();
    const r = await landing(admin as Client, "/admin/usage");
    expect(r.status).toBe(200);
  });

  it("管理员的 scope=all 是真的放行,不是也被降级了", async (ctx) => {
    if (!admin) ctx.skip();
    const r = await (admin as Client).get<UsageRes>("/api/usage?scope=all");
    expect(r.body.scope).toBe("all");
    expect(r.body.canViewAll).toBe(true);
  });

  it("管理员不带 scope 时仍然只看自己 —— 身份不隐式放大范围", async (ctx) => {
    if (!admin) ctx.skip();
    const r = await (admin as Client).get<GroupsRes>("/api/groups");
    expect(r.body.scope).toBe("self");
  });

  it("普通用户手敲 /admin/usage 会被弹回工作台", async () => {
    const r = await landing(member, "/admin/usage");
    expect(r.status).toBeGreaterThanOrEqual(300);
    expect(r.status).toBeLessThan(400);
    expect(r.location).toBe("/");
  });

  it("个人设置页对普通用户是开放的 —— 别把所有人都挡在外面就算安全", async () => {
    // 对照组:守卫只该拦 /admin/*,不该顺手把 /settings/* 也拦了
    const r = await landing(member, "/settings/credentials");
    expect(r.status).toBe(200);
  });

  it("普通用户请求 groups?scope=all 静默降级为只看自己", async () => {
    const other = await newUser("other");
    const theirs = await other.post<GroupRes>("/api/groups", { name: `他人的组-${Date.now()}` });
    expect(theirs.status).toBe(201);
    const theirId = theirs.body.group?.id ?? "";
    expect(theirId).toBeTruthy();

    const r = await member.get<GroupsRes>("/api/groups?scope=all");
    expect(r.status).toBe(200);
    // 关键:回的是 self,而且确实看不到别人的组
    expect(r.body.scope).toBe("self");
    expect(r.body.canViewAll).toBe(false);
    expect((r.body.groups ?? []).map((g) => g.id)).not.toContain(theirId);
  });

  it("普通用户请求 usage?scope=all 也降级,并如实告知无权查看全平台", async () => {
    const r = await member.get<UsageRes>("/api/usage?scope=all");
    expect(r.status).toBe(200);
    expect(r.body.scope).toBe("self");
    expect(r.body.canViewAll).toBe(false);
  });

  it("不带 scope 时默认只看自己 —— 范围不能靠身份隐式放大", async () => {
    /*
     * 这条守的是改造前的行为:groups 接口当时是「是 admin 就给全部」,
     * 于是「我的组」页面对管理员会列出全平台的组,名不副实。
     * 现在无论谁不带 scope,拿到的都是 self。
     */
    const r = await member.get<GroupsRes>("/api/groups");
    expect(r.body.scope).toBe("self");
  });
});

describe("旧地址不落空", () => {
  let member: Client;

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务。");
    member = await newUser("bookmark");
  });

  // 老书签和外部链接还指着改造前的地址,不能直接 404
  //
  // 【为什么 /builder 和 /settings/assistants 不在列】assistant→agent 改名时
  // 这两条转发被一并删掉了(见 0006 迁移那批改动),它们现在就是 404。
  // 留在这里会变成一条断言不存在行为的测试。
  const moved: [string, string][] = [
    ["/settings", "/settings/keys"],
    ["/usage", "/settings/usage"],
  ];

  for (const [from, to] of moved) {
    it(`${from} → ${to}`, async () => {
      const r = await landing(member, from);
      expect(r.location).toBe(to);
    });
  }
});
