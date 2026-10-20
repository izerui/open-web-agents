// 平台账号管理的端到端回归。
//
// 【为什么必须是端到端】这组断言守的是"平台会不会把自己锁死"以及
// "普通账号能不能给自己提权"—— 两者都跨越了路由、授权、仓储三层,
// 任何一层单测都覆盖不到接线本身。
//
// 而"停用立即生效"这条尤其只能在这里测:它依赖真实的 cookie 往返 ——
// 一张签名合法、尚未过期的会话 cookie,在账号被停用后必须立刻失效。

import { beforeAll, describe, expect, it } from "vitest";
import { type Client, newUser, serverUp } from "./client";

type AccountsRes = {
  accounts?: {
    id: string;
    email: string;
    role: string;
    disabled: boolean;
    monthlyLimitMicroCredits: string | null;
    agentCount: number;
    monthUsedMicroCredits: string;
  }[];
  error?: string;
};
type PatchRes = { account?: { role: string; disabled: boolean }; error?: string };
type MeRes = { authenticated: boolean; user?: { id: string; role: string } };

/**
 * 管理员对照组,整个文件共用。
 *
 * 【为什么不让每个 describe 自己注册一个】role 只在注册时定:
 * 库里【第一个】用户才是 admin。第二个 describe 再注册就只能拿到普通用户,
 * 于是它那组正向用例会全部 skip —— 而"额度拦截"恰恰是那一组里最该验的。
 * 第一个 beforeAll 抢到 admin 后放在这里,后面直接复用。
 */
let admin: Client | null = null;

describe("平台账号管理", () => {
  let member: Client;
  let memberId: string;

  beforeAll(async () => {
    if (!(await serverUp())) {
      throw new Error("e2e 需要一个跑着的服务。用 `pnpm test:e2e`(自动起停)。");
    }
    const first = await newUser("acct-admin");
    const firstMe = await first.get<MeRes>("/api/auth");
    if (firstMe.body.user?.role === "admin") admin = first;

    member = await newUser("acct-member");
    memberId = (await member.get<MeRes>("/api/auth")).body.user?.id ?? "";
    expect(memberId).toBeTruthy();
  });

  it("普通账号读不到账号列表", async () => {
    const r = await member.get<AccountsRes>("/api/admin/accounts");
    expect(r.status).toBe(403);
  });

  it("普通账号改不了任何人的角色 —— 包括给自己提权", async () => {
    const r = await member.req<PatchRes>("PATCH", "/api/admin/accounts", {
      body: { id: memberId, role: "admin" },
    });
    expect(r.status).toBe(403);

    // 确认真的没改成:换个视角复核,而不是只信这个 403
    const me = await member.get<MeRes>("/api/auth");
    expect(me.body.user?.role).toBe("user");
  });

  it("管理员能看到账号列表,且带着运营要的统计", async (ctx) => {
    if (!admin) ctx.skip();
    const r = await (admin as Client).get<AccountsRes>("/api/admin/accounts");
    expect(r.status).toBe(200);
    const found = (r.body.accounts ?? []).find((a) => a.id === memberId);
    expect(found).toBeDefined();
    expect(found?.role).toBe("user");
    expect(typeof found?.agentCount).toBe("number");
    expect(typeof found?.monthCostMicroUsd).toBe("number");
  });

  it("管理员能提升与取消他人的管理员身份", async (ctx) => {
    if (!admin) ctx.skip();
    const up = await (admin as Client).req<PatchRes>("PATCH", "/api/admin/accounts", {
      body: { id: memberId, role: "admin" },
    });
    expect(up.status).toBe(200);
    expect(up.body.account?.role).toBe("admin");

    const down = await (admin as Client).req<PatchRes>("PATCH", "/api/admin/accounts", {
      body: { id: memberId, role: "user" },
    });
    expect(down.status).toBe(200);
    expect(down.body.account?.role).toBe("user");
  });

  it("管理员不能改自己的角色 —— 防止把自己关在门外", async (ctx) => {
    if (!admin) ctx.skip();
    const selfId = (await (admin as Client).get<MeRes>("/api/auth")).body.user?.id;
    const r = await (admin as Client).req<PatchRes>("PATCH", "/api/admin/accounts", {
      body: { id: selfId, role: "user" },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("自己");
  });

  it("管理员不能停用自己", async (ctx) => {
    if (!admin) ctx.skip();
    const selfId = (await (admin as Client).get<MeRes>("/api/auth")).body.user?.id;
    const r = await (admin as Client).req<PatchRes>("PATCH", "/api/admin/accounts", {
      body: { id: selfId, disabled: true },
    });
    expect(r.status).toBe(400);
  });

  it("停用后,对方手上那张仍然合法的 cookie 立刻失效", async (ctx) => {
    if (!admin) ctx.skip();
    /*
     * 【为什么这条最重要】会话令牌签发后有 7 天有效期,签名一直是对的。
     * 若只在登录处拦截停用,一个正在使用中的账号被停用后,
     * 它当前这张 cookie 还能用满一周 —— 停用等于没做。
     */
    const victim = await newUser("acct-victim");
    const victimId = (await victim.get<MeRes>("/api/auth")).body.user?.id ?? "";
    expect((await victim.get<MeRes>("/api/auth")).body.authenticated).toBe(true);

    const off = await (admin as Client).req<PatchRes>("PATCH", "/api/admin/accounts", {
      body: { id: victimId, disabled: true },
    });
    expect(off.status).toBe(200);

    // 同一个 client、同一张 cookie,不重新登录
    const after = await victim.get<MeRes>("/api/auth");
    expect(after.body.authenticated).toBe(false);

    // 业务接口也该一并挡住,而不只是登录态查询
    const sessions = await victim.get("/api/sessions");
    expect(sessions.status).toBe(401);
  });

  it("停用是可逆的 —— 恢复后账号照常可用", async (ctx) => {
    if (!admin) ctx.skip();
    const u = await newUser("acct-restore");
    const uid = (await u.get<MeRes>("/api/auth")).body.user?.id ?? "";
    await (admin as Client).req("PATCH", "/api/admin/accounts", {
      body: { id: uid, disabled: true },
    });
    expect((await u.get<MeRes>("/api/auth")).body.authenticated).toBe(false);

    await (admin as Client).req("PATCH", "/api/admin/accounts", {
      body: { id: uid, disabled: false },
    });
    expect((await u.get<MeRes>("/api/auth")).body.authenticated).toBe(true);
  });

  it("月度积分上限可以设置、可以取消,负数与非数字被拒", async (ctx) => {
    if (!admin) ctx.skip();
    const ok = await (admin as Client).req<PatchRes>("PATCH", "/api/admin/accounts", {
      body: { id: memberId, monthlyLimitCredits: "500.5" },
    });
    expect(ok.status).toBe(200);

    const list = await (admin as Client).get<AccountsRes>("/api/admin/accounts");
    const row = list.body.accounts?.find((a) => a.id === memberId);
    expect(row?.monthlyLimitMicroCredits).toBe("500500000");
    expect(row?.monthUsedMicroCredits).toMatch(/^\d+$/);

    for (const bad of ["-1", "abc", 5]) {
      const r = await (admin as Client).req<PatchRes>("PATCH", "/api/admin/accounts", {
        body: { id: memberId, monthlyLimitCredits: bad },
      });
      expect(r.status, String(bad)).toBe(400);
    }

    const cleared = await (admin as Client).req<PatchRes>("PATCH", "/api/admin/accounts", {
      body: { id: memberId, monthlyLimitCredits: null },
    });
    expect(cleared.status).toBe(200);
    const list2 = await (admin as Client).get<AccountsRes>("/api/admin/accounts");
    expect(
      list2.body.accounts?.find((a) => a.id === memberId)?.monthlyLimitMicroCredits,
    ).toBeNull();
  });

  it("改不存在的账号返回 404", async (ctx) => {
    if (!admin) ctx.skip();
    const r = await (admin as Client).req<PatchRes>("PATCH", "/api/admin/accounts", {
      body: { id: "no-such-account", disabled: true },
    });
    expect(r.status).toBe(404);
  });
});

describe("月度积分上限对运行路径的拦截", () => {
  type Mode = "trial" | "live";
  const setMode = (mode: Mode) =>
    (admin as Client).put("/api/admin/billing-mode", { mode }).then((r) => {
      expect(r.status).toBe(200);
    });
  const newSession = async (tag: string) => {
    const u = await newUser(tag);
    const uid = (await u.get<MeRes>("/api/auth")).body.user?.id ?? "";
    const s = await u.post<{ session?: { id: string } }>("/api/sessions", { agentId: "default" });
    expect(s.status).toBe(201);
    return { u, uid, sid: s.body.session?.id ?? "" };
  };
  const limit = (uid: string, credits: string | null) =>
    (admin as Client).req("PATCH", "/api/admin/accounts", {
      body: { id: uid, monthlyLimitCredits: credits },
    });
  const run = (u: Client, sid: string) =>
    u.post<{ code?: string; error?: string }>(`/api/sessions/${sid}/run`, {
      prompt: "hi",
      stream: false,
    });

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务。");
  });

  it("试算模式:上限为 0 也不拦截(只记本应拒绝)", async (ctx) => {
    if (!admin) ctx.skip();
    await setMode("trial");
    try {
      const { u, uid, sid } = await newSession("limit-trial");
      expect((await limit(uid, "0")).status).toBe(200);
      expect((await run(u, sid)).status).not.toBe(402);
    } finally {
      await setMode("trial"); // 以试算为基线,见 run-charging.e2e.ts
    }
  });

  it("正式模式:上限为 0 时 402 account_limit_exceeded;取消上限后不再因上限被拒", async (ctx) => {
    if (!admin) ctx.skip();
    await setMode("live");
    try {
      /*
       * 【为什么用 0】0 不依赖"这个账号已经用了多少" —— 全新账号用量是 0,
       * 任何正数上限都拦不住它,这条测试就会变成恒过的空断言。
       */
      const { u, uid, sid } = await newSession("limit-live");
      expect((await limit(uid, "0")).status).toBe(200);
      const blocked = await run(u, sid);
      expect(blocked.status).toBe(402);
      expect(blocked.body.code).toBe("account_limit_exceeded");

      expect((await limit(uid, null)).status).toBe(200);
      // 取消上限后不再是上限拒绝(新账号没有积分,正式模式下会是余额不足)
      const after = await run(u, sid);
      expect(after.body.code).not.toBe("account_limit_exceeded");
    } finally {
      await setMode("trial"); // 以试算为基线,见 run-charging.e2e.ts
    }
  });
});
