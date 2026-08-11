import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetMe, clearMe, initialsOf, isAdminView, peekMe, refreshMe } from "../use-me";

afterEach(() => {
  __resetMe();
  vi.unstubAllGlobals();
});

/** 让 fetch 返回一个成功的 /api/auth 响应,并记录被调用了几次。 */
function stubAuth(email: string) {
  const calls = { n: 0 };
  vi.stubGlobal("fetch", async () => {
    calls.n += 1;
    return new Response(JSON.stringify({ authenticated: true, user: { email } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return calls;
}

describe("initialsOf", () => {
  it("有分隔符时取两段的首字母", () => {
    expect(initialsOf("li.hua@example.com")).toBe("LH");
    expect(initialsOf("mary_jane@x.io")).toBe("MJ");
    expect(initialsOf("a-b@x.io")).toBe("AB");
    // 加号常见于邮箱别名(foo+github@),不该把 "+github" 当成姓
    expect(initialsOf("foo+github@x.io")).toBe("FG");
  });

  it("没有分隔符时取前两个字符", () => {
    expect(initialsOf("admin@example.com")).toBe("AD");
  });

  it("单字符邮箱不会越界", () => {
    expect(initialsOf("a@x.io")).toBe("A");
  });

  it("退化输入也要给得出东西 —— 头像位置不能是空白", () => {
    // 本地部分为空(@ 开头)是非法邮箱,但界面不该因为脏数据崩掉或留白
    expect(initialsOf("@x.io")).toBe("?");
    expect(initialsOf("")).toBe("?");
  });
});

describe("isAdminView", () => {
  it("真实 admin 算", () => {
    expect(isAdminView({ authenticated: true, user: { role: "admin" } as never })).toBe(true);
  });

  it("普通用户不算 —— 哪怕平台没开登录要求", () => {
    expect(
      isAdminView({ authenticated: true, authRequired: false, user: { role: "user" } as never }),
    ).toBe(false);
  });

  it("本地模式(未开登录且无账号)算管理员", () => {
    /*
     * 【为什么这条最容易写错】直觉上"没登录"就该不是管理员。
     * 但 OWA_AUTH_REQUIRED=0 时后端发的是匿名 admin,scope=all 对它放行、
     * requireAdmin 也放行 —— 前端若判成 false,就会出现
     * "接口愿意给全平台数据、界面却没有入口"的错位。
     */
    expect(isAdminView({ authenticated: false, authRequired: false })).toBe(true);
  });

  it("要求登录但没登录,不算", () => {
    expect(isAdminView({ authenticated: false, authRequired: true })).toBe(false);
  });

  it("还没拿到登录态时不算 —— 加载中不能先把管理入口闪出来", () => {
    expect(isAdminView(null)).toBe(false);
  });
});

describe("共享登录态", () => {
  it("refreshMe 会真的重新请求,而不是吃缓存", async () => {
    const calls = stubAuth("a@x.io");
    await refreshMe();
    await refreshMe();
    expect(calls.n).toBe(2);
  });

  it("clearMe 之后不再残留上一个账号", async () => {
    /*
     * 【为什么单独测这个】cache 是模块级的,不随路由跳转重置。
     * 登出后如果不清,换个账号登进来,侧栏可能还挂着上一个人的邮箱 ——
     * 在多人共用的机器上这是会出事的。
     */
    stubAuth("first@x.io");
    await refreshMe();
    expect(peekMe()?.user?.email).toBe("first@x.io");

    clearMe();
    expect(peekMe()).toBeNull();

    stubAuth("second@x.io");
    await refreshMe();
    expect(peekMe()?.user?.email).toBe("second@x.io");
  });

  it("refreshMe 失败时保留旧值,不把界面清空", async () => {
    stubAuth("keep@x.io");
    await refreshMe();

    vi.stubGlobal("fetch", async () => new Response("boom", { status: 500 }));
    // 不抛错是这里的契约:导航区的头像不该因为一次网络抖动就炸掉整页
    await expect(refreshMe()).resolves.toBeUndefined();
    expect(peekMe()?.user?.email).toBe("keep@x.io");
  });
});
