import { type AuthError, AuthService } from "@/lib/modules/identity/application/auth-service";
import { SESSION_COOKIE } from "@/lib/modules/identity/domain/session-token";
import type { NewUser, User, UserRepo } from "@/lib/modules/identity/user-ports";
import { describe, expect, it } from "vitest";

class InMemoryUserRepo implements UserRepo {
  private byId = new Map<string, User & { passwordHash: string }>();

  async create(u: NewUser): Promise<User> {
    const rec = {
      id: u.id,
      email: u.email.toLowerCase(),
      role: u.role ?? ("user" as const),
      passwordHash: u.passwordHash,
      disabled: false,
      createdAt: 1000,
    };
    this.byId.set(u.id, rec);
    const { passwordHash: _p, ...user } = rec;
    return user;
  }
  async findByEmail(email: string) {
    for (const r of this.byId.values()) {
      if (r.email === email.trim().toLowerCase()) return r;
    }
    return null;
  }
  async get(id: string): Promise<User | null> {
    const r = this.byId.get(id);
    if (!r) return null;
    const { passwordHash: _p, ...user } = r;
    return user;
  }
  async count(): Promise<number> {
    return this.byId.size;
  }
  async setCredentials(
    id: string,
    v: { defaultBaseUrl?: string | null; anthropicKeyEnc?: string | null },
  ): Promise<void> {
    const r = this.byId.get(id);
    if (!r) return;
    if (v.defaultBaseUrl !== undefined) r.defaultBaseUrl = v.defaultBaseUrl ?? undefined;
    if (v.anthropicKeyEnc !== undefined) r.anthropicKeyEnc = v.anthropicKeyEnc ?? undefined;
  }
  async listAll(limit = 500): Promise<User[]> {
    return [...this.byId.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map(({ passwordHash: _p, ...u }) => u);
  }
  async adminUpdate(
    id: string,
    v: { role?: "admin" | "user"; disabled?: boolean; monthlyQuotaMicroUsd?: number | null },
  ): Promise<void> {
    const r = this.byId.get(id);
    if (!r) return;
    if (v.role !== undefined) r.role = v.role;
    if (v.disabled !== undefined) r.disabled = v.disabled;
    if (v.monthlyQuotaMicroUsd !== undefined)
      r.monthlyQuotaMicroUsd = v.monthlyQuotaMicroUsd ?? undefined;
  }
  async countAdmins(): Promise<number> {
    return [...this.byId.values()].filter((u) => u.role === "admin").length;
  }
  /** 测试用:删掉用户,模拟"令牌有效但账号已删"。 */
  _delete(id: string) {
    this.byId.delete(id);
  }
}

function setup() {
  const users = new InMemoryUserRepo();
  const auth = new AuthService({ users, sessionSecret: "s3cret", secureCookie: false });
  return { users, auth };
}

function reqWithCookie(cookie: string): Request {
  return new Request("http://x/", { headers: { cookie } });
}

/** 从 Set-Cookie 里抽出裸 token,便于构造后续请求。 */
function tokenOf(setCookie: string): string {
  return `${SESSION_COOKIE}=${setCookie.split(";")[0]?.split("=").slice(1).join("=")}`;
}

describe("AuthService.register", () => {
  it("首个用户自动成为 admin(自托管免初始化脚本)", async () => {
    const { auth } = setup();
    const { user } = await auth.register("first@x.com", "password123");
    expect(user.role).toBe("admin");
  });

  it("后续用户是普通角色", async () => {
    const { auth } = setup();
    await auth.register("first@x.com", "password123");
    const { user } = await auth.register("second@x.com", "password123");
    expect(user.role).toBe("user");
  });

  it("邮箱大小写归一,不产生重复账号", async () => {
    const { auth } = setup();
    await auth.register("Foo@X.com", "password123");
    await expect(auth.register("foo@x.com", "password123")).rejects.toThrow(/已注册/);
  });

  it("拒绝格式非法的邮箱", async () => {
    const { auth } = setup();
    await expect(auth.register("notanemail", "password123")).rejects.toThrow(/邮箱格式/);
  });

  it("拒绝过短的密码", async () => {
    const { auth } = setup();
    await expect(auth.register("a@x.com", "short")).rejects.toThrow(/至少 8 位/);
  });

  it("注册即返回登录 cookie(HttpOnly)", async () => {
    const { auth } = setup();
    const { cookie } = await auth.register("a@x.com", "password123");
    expect(cookie).toContain(SESSION_COOKIE);
    expect(cookie).toContain("HttpOnly");
  });
});

describe("AuthService.login", () => {
  it("正确凭据登录成功", async () => {
    const { auth } = setup();
    await auth.register("a@x.com", "password123");
    const { user } = await auth.login("a@x.com", "password123");
    expect(user.email).toBe("a@x.com");
  });

  it("密码错误与邮箱不存在返回同一错误(防邮箱枚举)", async () => {
    const { auth } = setup();
    await auth.register("a@x.com", "password123");
    const e1 = await auth.login("a@x.com", "wrongpass").catch((e: AuthError) => e.message);
    const e2 = await auth.login("nobody@x.com", "whatever").catch((e: AuthError) => e.message);
    expect(e1).toBe(e2);
  });

  it("登录失败是 401", async () => {
    const { auth } = setup();
    await expect(auth.login("nobody@x.com", "password123")).rejects.toMatchObject({ status: 401 });
  });

  it("返回的响应体里不含密码哈希", async () => {
    const { auth } = setup();
    await auth.register("a@x.com", "password123");
    const { user } = await auth.login("a@x.com", "password123");
    expect(JSON.stringify(user)).not.toContain("scrypt$");
  });
});

describe("AuthService.currentUser", () => {
  it("带有效 cookie 能解析出用户", async () => {
    const { auth } = setup();
    const { user, cookie } = await auth.register("a@x.com", "password123");
    const found = await auth.currentUser(reqWithCookie(tokenOf(cookie)));
    expect(found?.id).toBe(user.id);
  });

  it("无 cookie 返回 null", async () => {
    const { auth } = setup();
    expect(await auth.currentUser(new Request("http://x/"))).toBeNull();
  });

  it("伪造的 cookie 返回 null", async () => {
    const { auth } = setup();
    expect(await auth.currentUser(reqWithCookie(`${SESSION_COOKIE}=fake.999.sig`))).toBeNull();
  });

  it("令牌有效但用户已删除 → 视为未登录", async () => {
    const { auth, users } = setup();
    const { user, cookie } = await auth.register("a@x.com", "password123");
    users._delete(user.id);
    expect(await auth.currentUser(reqWithCookie(tokenOf(cookie)))).toBeNull();
  });

  it("账号被停用后,手上那张仍然合法的 cookie 立刻失效", async () => {
    /*
     * 【为什么这条最关键】会话令牌签发后有 7 天有效期,签名一直是对的。
     * 如果只在 login 处拦截停用,一个正在使用中的账号被停用后,
     * 它当前这张 cookie 还能继续用满一周 —— 那"停用"这个动作等于没做。
     */
    const { auth, users } = setup();
    const { user, cookie } = await auth.register("a@x.com", "password123");
    const token = tokenOf(cookie);
    expect(await auth.currentUser(reqWithCookie(token))).not.toBeNull();

    await users.adminUpdate(user.id, { disabled: true });
    expect(await auth.currentUser(reqWithCookie(token))).toBeNull();
  });

  it("解除停用后又能用了 —— 停用是可逆的,不是删号", async () => {
    const { auth, users } = setup();
    const { user, cookie } = await auth.register("a@x.com", "password123");
    const token = tokenOf(cookie);
    await users.adminUpdate(user.id, { disabled: true });
    await users.adminUpdate(user.id, { disabled: false });
    expect((await auth.currentUser(reqWithCookie(token)))?.id).toBe(user.id);
  });
});

describe("停用账号的登录", () => {
  it("被停用的账号密码正确也登不上", async () => {
    const { auth, users } = setup();
    const { user } = await auth.register("a@x.com", "password123");
    await users.adminUpdate(user.id, { disabled: true });
    await expect(auth.login("a@x.com", "password123")).rejects.toMatchObject({ status: 403 });
  });

  it("密码错误时报的仍是 401,不泄露账号是否存在", async () => {
    /*
     * 【为什么要单独守这一条】如果把停用检查放在密码校验【之前】,
     * 这个接口就成了账号存在性预言机:拿一个乱密码去试,
     * 回 403「已停用」说明这个邮箱注册过,回 401 说明没注册。
     * 顺序必须是:先证明你是账号主人,再告诉你账号状态。
     */
    const { auth, users } = setup();
    const { user } = await auth.register("a@x.com", "password123");
    await users.adminUpdate(user.id, { disabled: true });
    await expect(auth.login("a@x.com", "wrong-password")).rejects.toMatchObject({ status: 401 });
  });
});

describe("AuthService.logoutCookie", () => {
  it("登出 cookie 立即过期", () => {
    const { auth } = setup();
    expect(auth.logoutCookie()).toContain("Max-Age=0");
  });
});
