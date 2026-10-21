// 消耗汇总接口的权限与参数:默认只看自己;看别的账号或全平台须是管理员;
// 账号维度只在全平台、Key 维度只在单个账号;窗口与维度不合法 400。
import { Forbidden } from "@/lib/modules/access/application/authorize";
import { monthWindowUtc } from "@/lib/modules/billing/domain/run-charge";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  admin: false,
  calls: [] as { accountId?: string; since: number; until: number; by: string }[],
}));
vi.mock("@/lib/container", () => ({
  getContainer: () => ({
    auth: {
      resolveWeb: async () => ({ type: "web", userId: "me" }),
      assertCanAdministerPlatform: () => {
        if (!state.admin) throw new Forbidden("admin only");
      },
    },
    users: { get: async (id: string) => (["me", "u2"].includes(id) ? { id } : null) },
    runCharges: {
      summarize: async (opts: (typeof state.calls)[number]) => {
        state.calls.push(opts);
        return [
          {
            key: "web",
            name: null,
            runs: 2,
            chargedMicro: "10",
            owedMicro: "1",
            reservedMicro: "5",
            usedMicro: "16",
          },
          {
            key: "api",
            name: null,
            runs: 1,
            chargedMicro: "3",
            owedMicro: "0",
            reservedMicro: "0",
            usedMicro: "3",
          },
        ];
      },
    },
  }),
}));
import { GET } from "../summary/route";

const get = async (qs: string) => {
  const r = await GET(new Request(`http://test/api/billing/summary?${qs}`));
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

describe("GET /api/billing/summary", () => {
  beforeEach(() => {
    state.admin = false;
    state.calls = [];
  });

  it("默认看自己本月、按来源,带合计", async () => {
    const r = await get("");
    expect(r.status).toBe(200);
    const month = monthWindowUtc(Date.now());
    expect(state.calls).toEqual([{ accountId: "me", ...month, by: "source" }]);
    expect(r.body.total).toEqual({
      runs: 3,
      chargedMicro: "13",
      owedMicro: "1",
      reservedMicro: "5",
      usedMicro: "19",
    });
  });

  it("普通用户看别的账号或全平台 403;管理员可以", async () => {
    expect((await get("accountId=u2")).status).toBe(403);
    expect((await get("scope=all")).status).toBe(403);
    expect(state.calls).toEqual([]);
    state.admin = true;
    expect((await get("accountId=u2&by=key")).status).toBe(200);
    expect((await get("scope=all&by=account")).status).toBe(200);
    expect(state.calls.map((c) => [c.accountId, c.by])).toEqual([
      ["u2", "key"],
      [undefined, "account"],
    ]);
    expect((await get("accountId=nobody")).status).toBe(404);
  });

  it("维度与窗口:账号维度只在全平台,Key 维度只在单个账号;不合法 400", async () => {
    state.admin = true;
    expect((await get("by=account")).status).toBe(400);
    expect((await get("scope=all&by=key")).status).toBe(400);
    expect((await get("by=nope")).status).toBe(400);
    expect((await get("window=yesterday")).status).toBe(400);
    expect(state.calls).toEqual([]);
  });
});
