import { Forbidden } from "@/lib/modules/access/application/authorize";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ admin: true, calls: [] as unknown[] }));
vi.mock("@/lib/container", () => ({
  getContainer: () => ({
    auth: {
      resolveWeb: async () => ({ type: "web", userId: "admin" }),
      assertCanAdministerPlatform: () => {
        if (!state.admin) throw new Forbidden("admin only");
      },
    },
    runCharges: {
      listPending: async (opts: unknown) => {
        state.calls.push(opts);
        return { items: [] };
      },
      pendingCounts: async () => ({ owed: 1, usage_unknown: 2, unpriced: 3 }),
    },
  }),
}));
import { GET } from "../route";

const get = (q = "") => GET(new Request(`http://test/api/admin/billing-pending${q}`));

describe("GET /api/admin/billing-pending", () => {
  beforeEach(() => {
    state.admin = true;
    state.calls = [];
  });

  it("只有管理员能看", async () => {
    state.admin = false;
    expect((await get()).status).toBe(403);
    expect(state.calls).toEqual([]);
  });

  it("筛选参数原样传给查询,返回列表与各原因条数", async () => {
    const r = await get("?reason=owed&limit=20&cursor=1_x");
    expect(r.status).toBe(200);
    expect(state.calls).toEqual([{ reason: "owed", limit: 20, cursor: "1_x" }]);
    expect(await r.json()).toEqual({
      items: [],
      counts: { owed: 1, usage_unknown: 2, unpriced: 3 },
    });
  });

  it("参数不合法:400", async () => {
    for (const q of ["?reason=nope", "?limit=0", "?limit=101"]) {
      expect((await get(q)).status, q).toBe(400);
    }
  });
});
