import { GET as getAuth } from "@/app/api/auth/route";
import { PUT as putCredentials } from "@/app/api/me/credentials/route";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetMe, clearMe, initialsOf, isAdminView, peekMe, refreshMe } from "../use-me";

const account = vi.hoisted(() => ({
  currentUser: vi.fn(),
  setCredentials: vi.fn(),
  decrypt: vi.fn(),
  encrypt: vi.fn(),
  record: vi.fn(),
}));

vi.mock("@/lib/container", () => ({
  getContainer: () => ({
    authService: { currentUser: account.currentUser },
    users: { setCredentials: account.setCredentials },
    secrets: { decrypt: account.decrypt, encrypt: account.encrypt },
    audit: { record: account.record },
    env: { authRequired: true, allowSignup: false },
  }),
}));

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
  it("账号响应不再需要模型地址或密钥掩码", async () => {
    const user = {
      id: "account",
      email: "account@example.test",
      role: "user",
      webhookSecretMask: null,
    };
    vi.stubGlobal("fetch", async () => Response.json({ authenticated: true, user }));
    await refreshMe();
    expect(peekMe()?.user).toEqual(user);
    expect(peekMe()?.user).not.toHaveProperty("defaultBaseUrl");
    expect(peekMe()?.user).not.toHaveProperty("anthropicKeyMask");
  });

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

describe("账号模型凭证退役", () => {
  const user = {
    id: "account",
    email: "account@example.test",
    role: "user",
    defaultBaseUrl: "https://old-gateway.example?token=old-secret",
    anthropicKeyEnc: "invalid-retired-model-ciphertext",
  };
  const request = () => new Request("https://platform.example/api/auth");

  beforeEach(() => {
    for (const mock of Object.values(account)) mock.mockReset();
    account.currentUser.mockResolvedValue(user);
    account.decrypt.mockImplementation(() => {
      throw new Error("retired model key must not be decrypted");
    });
  });

  it("登录态忽略旧模型凭证,即使旧密文不可解密也能读取账号", async () => {
    const response = await getAuth(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      authenticated: true,
      authRequired: true,
      user: { id: user.id, email: user.email, role: user.role, webhookSecretMask: null },
    });
    expect(account.decrypt).not.toHaveBeenCalled();
  });

  it("继续提供 webhook 签名掩码,只解密 webhook 密钥", async () => {
    account.currentUser.mockResolvedValue({ ...user, webhookSecretEnc: "webhook-ciphertext" });
    account.decrypt.mockReturnValue("whsec_existing_integration_secret");
    const response = await getAuth(request());
    const body = await response.json();
    expect(body.user.webhookSecretMask).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain("whsec_existing_integration_secret");
    expect(body.user).not.toHaveProperty("anthropicKeyMask");
    expect(body.user).not.toHaveProperty("defaultBaseUrl");
    expect(account.decrypt).toHaveBeenCalledTimes(1);
    expect(account.decrypt).toHaveBeenCalledWith("webhook-ciphertext");
  });

  it("未登录仍返回公开登录状态", async () => {
    account.currentUser.mockResolvedValue(null);
    expect(await (await getAuth(request())).json()).toEqual({
      authenticated: false,
      authRequired: true,
      allowSignup: false,
    });
    expect(account.decrypt).not.toHaveBeenCalled();
  });

  it.each(["user", "admin"])("登录的 %s 请求旧接口返回410,不读取或保存密钥", async (role) => {
    account.currentUser.mockResolvedValue({ ...user, role });
    const req = new Request("https://platform.example/api/me/credentials", {
      method: "PUT",
      body: JSON.stringify({ baseUrl: "https://new-gateway.example", apiKey: "sk-new-secret" }),
    });
    const readBody = vi.spyOn(req, "json");
    const response = await putCredentials(req);
    expect(response.status).toBe(410);
    const body = await response.json();
    expect(body).toMatchObject({ code: "byok_disabled" });
    expect(body.error).toContain("平台");
    expect(JSON.stringify(body)).not.toContain("sk-new-secret");
    expect(readBody).not.toHaveBeenCalled();
    expect(account.setCredentials).not.toHaveBeenCalled();
    expect(account.decrypt).not.toHaveBeenCalled();
    expect(account.encrypt).not.toHaveBeenCalled();
    expect(account.record).not.toHaveBeenCalled();
  });

  it("未登录调用旧接口仍返回401,不写审计", async () => {
    account.currentUser.mockResolvedValue(null);
    const response = await putCredentials(
      new Request("https://platform.example/api/me/credentials", { method: "PUT" }),
    );
    expect(response.status).toBe(401);
    expect(account.setCredentials).not.toHaveBeenCalled();
    expect(account.record).not.toHaveBeenCalled();
  });
});
