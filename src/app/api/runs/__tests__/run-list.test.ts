import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: "alice",
  role: "user" as "admin" | "user",
  filters: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/container", () => ({
  getContainer: () => ({
    runQuery: {
      list: async (f: Record<string, unknown>) => {
        state.filters.push(f);
        return { items: [] };
      },
    },
    auth: {
      resolveWeb: async () => ({ type: "web", userId: state.user, role: state.role }),
    },
  }),
}));

import { GET } from "../route";

const list = async (qs: string) => {
  const res = await GET(new Request(`http://local/api/runs?${qs}`));
  expect(res.status).toBe(200);
  return state.filters.at(-1) ?? {};
};

beforeEach(() => {
  state.user = "alice";
  state.role = "user";
  state.filters = [];
});

describe("GET /api/runs:平台运行带账号,个人运行不带别人的信息", () => {
  it("管理员 scope=all:不限账号,并带上计费账号(邮箱)", async () => {
    state.user = "root";
    state.role = "admin";
    const f = await list("scope=all");
    expect(f.billingUserId).toBeUndefined();
    expect(f.withAccount).toBe(true);
  });

  it("管理员 scope=all 可按账号筛选", async () => {
    state.user = "root";
    state.role = "admin";
    const f = await list("scope=all&accountId=bob");
    expect(f.billingUserId).toBe("bob");
    expect(f.withAccount).toBe(true);
  });

  it("普通用户:只能看自己名下的,传 accountId 也不生效,不带账号信息", async () => {
    const f = await list("scope=all&accountId=bob");
    expect(f.billingUserId).toBe("alice");
    expect(f.withAccount).toBeFalsy();
  });

  it("管理员看自己的运行记录(不带 scope=all):同普通用户", async () => {
    state.user = "root";
    state.role = "admin";
    const f = await list("accountId=bob");
    expect(f.billingUserId).toBe("root");
    expect(f.withAccount).toBeFalsy();
  });
});
