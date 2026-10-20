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
      reconciliationRows: async (opts: unknown) => {
        state.calls.push(opts);
        return {
          truncated: false,
          rows: [
            {
              day: "2026-10-20",
              providerId: "p1",
              pricing: { providerId: "p1", models: [] },
              state: "settled",
              started: true,
              finalWaitSettled: false,
              estimatedMicro: "0",
              chargedMicro: "0",
              cost: null,
              snapshot: null,
            },
          ],
        };
      },
    },
    pricedModels: { forRun: async () => [] },
    providers: { list: async () => [{ id: "p1", name: "平台默认" }] },
  }),
}));
import { GET } from "../route";

const get = (q: string) => GET(new Request(`http://test/api/admin/billing-reconciliation${q}`));

describe("GET /api/admin/billing-reconciliation", () => {
  beforeEach(() => {
    state.admin = true;
    state.calls = [];
  });

  it("只有管理员能看", async () => {
    state.admin = false;
    expect((await get("?from=2026-10-01&to=2026-10-20")).status).toBe(403);
  });

  it("日期与区间校验", async () => {
    for (const q of [
      "",
      "?from=2026-10-1&to=2026-10-20",
      "?from=2026-10-20&to=2026-10-01",
      "?from=2026-09-01&to=2026-10-20",
      "?from=2026-10-01&to=2026-10-20&mode=x",
    ]) {
      expect((await get(q)).status, q).toBe(400);
    }
    expect(state.calls).toEqual([]);
  });

  it("返回带提供者名称的汇总;缺失数据按类别计条数", async () => {
    const r = await get("?from=2026-10-14&to=2026-10-20&mode=trial");
    expect(r.status).toBe(200);
    expect(state.calls).toEqual([
      { from: "2026-10-14", to: "2026-10-20", mode: "trial", limit: 50000 },
    ]);
    const body = (await r.json()) as {
      lines: { providerName: string; counts: { no_usage_zero: number }; costMicro: string }[];
    };
    expect(body.lines[0]).toMatchObject({
      providerName: "平台默认",
      counts: { no_usage_zero: 1 },
      costMicro: "0",
    });
  });
});
