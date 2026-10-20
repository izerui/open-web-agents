import type { Capability } from "@/lib/modules/capabilities/domain/catalog";
import type { RunModelBinding } from "@/lib/modules/model-gateway/domain/resolve-run-models";
import { type RunPricing, isUnavailableAtAdmission } from "@/lib/shared";
import { describe, expect, it } from "vitest";
import { InMemoryChargeWorld } from "../../adapters/in-memory-run-charge-store";
import type { BillingMode } from "../../domain/run-charge";
import { monthWindowUtc } from "../../domain/run-charge";
import { ChargeRejected, RunCharging } from "../run-charging";

const C = 1_000_000n; // 1 积分
// 售价:输入 2310 积分/百万 token,输出 11550 积分/百万 token
const model: Capability = {
  id: "m-main",
  name: "主力",
  kind: "llm",
  modelId: "up-main",
  enabled: true,
  acceptsImages: false,
  providerId: "p",
  rates: [
    { meter: "input_token", units: "1000000", microCredits: "2310000000" },
    { meter: "output_token", units: "1000000", microCredits: "11550000000" },
  ],
  version: 3,
  updatedAt: 0,
};
const pricing: RunPricing = {
  providerId: "p",
  models: [{ capabilityId: "m-main", modelId: "up-main", version: 3 }],
  binding: {
    mainRef: "m-main",
    main: "m-main",
    subagents: {},
    slots: { fable: null, opus: null, sonnet: null, haiku: null },
  },
};
const binding = { pricing, main: { capabilityId: "m-main" } } as unknown as RunModelBinding;

function setup(mode: BillingMode = "trial", reserve = 300n * C, now?: () => number) {
  const world = new InMemoryChargeWorld();
  const state = { mode };
  const charging = new RunCharging({
    mode: async () => state.mode,
    bind: async () => binding,
    reserveTargetOf: async () => reserve,
    pricedModels: async () => [model],
    transaction: world.transaction,
    now,
  });
  const admit = (runId: string, over: { accountId?: string; apiKeyId?: string | null } = {}) =>
    world.transaction(async (store) => {
      const p = await charging.admit(store, {
        runId,
        accountId: over.accountId ?? "u1",
        apiKeyId: over.apiKeyId ?? null,
        main: "m-main",
      });
      world.setRun(runId, {
        status: "pending",
        cost: null,
        pricing: isUnavailableAtAdmission(p) ? null : p,
        startedAt: null,
      });
      return p;
    });
  // 2 万输入 + 1 千输出 = 46.2 + 11.55 = 57.75 积分
  const finish = (runId: string, status = "success") =>
    world.setRun(runId, {
      status,
      pricing,
      startedAt: 1,
      cost: {
        input: 20000,
        output: 1000,
        metering: {
          source: "sdk_model_usage",
          complete: true,
          models: [
            {
              modelId: "up-main",
              inputTokens: 20000,
              outputTokens: 1000,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          ],
        },
      },
    });
  return { world, state, charging, admit, finish };
}

const EXPECTED = 57_750_000n.toString();

describe("试算模式:不拦截、不扣款", () => {
  it("余额为 0 也受理,只记本应拒绝;结束后余额不变、实际扣 0、记预计消耗", async () => {
    const { world, charging, admit, finish } = setup("trial");
    const p = await admit("r1");
    expect(p).toBe(pricing);
    expect(world.charge("r1")).toMatchObject({
      mode: "trial",
      wouldReject: "insufficient_balance",
      reservedMicro: (300n * C).toString(),
      holds: [],
      state: "open",
    });
    finish("r1");
    expect(await charging.settle("r1")).toBe("settled");
    expect(world.charge("r1")).toMatchObject({
      estimatedMicro: EXPECTED,
      chargedMicro: "0",
      state: "settled",
    });
    expect(world.balance("u1")).toEqual({ available: 0n, reserved: 0n });
  });

  it("有余额:非零售价运行结束,钱包一分不动", async () => {
    const { world, charging, admit, finish } = setup("trial");
    world.credit("u1", 1000n * C);
    await admit("r1");
    expect(world.charge("r1")?.wouldReject).toBeNull();
    expect(world.balance("u1")).toEqual({ available: 1000n * C, reserved: 0n });
    for (const status of ["success"]) finish("r1", status);
    await charging.settle("r1");
    expect(world.balance("u1")).toEqual({ available: 1000n * C, reserved: 0n });
    expect(world.charge("r1")?.chargedMicro).toBe("0");
  });

  it("中途停止、失败、未开始就取消:都只记预计消耗,实际扣 0", async () => {
    const { world, charging, admit, finish } = setup("trial");
    world.credit("u1", 1000n * C);
    for (const [id, status] of [
      ["a", "cancelled"],
      ["b", "failed"],
    ] as const) {
      await admit(id);
      finish(id, status);
      await charging.settle(id);
      expect(world.charge(id)).toMatchObject({ chargedMicro: "0", estimatedMicro: EXPECTED });
    }
    await admit("c");
    world.setRun("c", { status: "cancelled", cost: null, pricing, startedAt: null });
    await charging.settle("c");
    expect(world.charge("c")).toMatchObject({
      chargedMicro: "0",
      estimatedMicro: "0",
      incomplete: false,
    });
    expect(world.balance("u1").available).toBe(1000n * C);
  });

  it("试算在途冻结计入试算可用余额:第二次超出余额记本应拒绝,但仍放行", async () => {
    const { world, admit } = setup("trial", 300n * C);
    world.credit("u1", 400n * C);
    await admit("r1");
    await admit("r2");
    expect(world.charge("r1")?.wouldReject).toBeNull();
    expect(world.charge("r2")).toMatchObject({
      wouldReject: null,
      reservedMicro: (100n * C).toString(),
    });
    await admit("r3");
    expect(world.charge("r3")?.wouldReject).toBe("insufficient_balance");
  });
});

describe("正式模式", () => {
  it("余额不足:拒绝,且整个事务回滚(不留 run_charges)", async () => {
    const { world, admit } = setup("live");
    world.credit("u1", 10n * C);
    await expect(admit("r1")).rejects.toBeInstanceOf(ChargeRejected);
    expect(world.charge("r1")).toBeNull();
    expect(world.balance("u1")).toEqual({ available: 10n * C, reserved: 0n });
  });

  it("冻结 min(目标, 可用);结束按实际扣除、其余释放", async () => {
    const { world, charging, admit, finish } = setup("live");
    world.credit("u1", 1000n * C);
    await admit("r1");
    expect(world.balance("u1")).toEqual({ available: 700n * C, reserved: 300n * C });
    finish("r1");
    await charging.settle("r1");
    expect(world.balance("u1")).toEqual({ available: 1000n * C - 57_750_000n, reserved: 0n });
    expect(world.charge("r1")).toMatchObject({ chargedMicro: EXPECTED, state: "settled" });
  });

  it("实际超出冻结:超出部分补扣;余额不够补扣记欠额并标待核对", async () => {
    const { world, charging, admit, finish } = setup("live", 50n * C);
    world.credit("u1", 1000n * C);
    await admit("r1");
    finish("r1");
    await charging.settle("r1");
    expect(world.balance("u1").available).toBe(1000n * C - 57_750_000n);

    const t = setup("live", 50n * C);
    t.world.credit("u1", 52n * C);
    await t.admit("r1");
    t.finish("r1");
    await t.charging.settle("r1");
    const c = t.world.charge("r1");
    // 欠款没收齐:保持可重试(暂记),充值后补扣
    expect(c).toMatchObject({ incomplete: true, state: "provisional" });
    expect(BigInt(c?.owedMicro ?? "0")).toBeGreaterThan(0n);
    expect(BigInt(c?.chargedMicro ?? "0") + BigInt(c?.owedMicro ?? "0")).toBe(57_750_000n);
  });

  it("同一 Key 并发两次运行,月度额度只够一次:只有一次成功", async () => {
    const { world, admit } = setup("live", 300n * C);
    world.credit("u1", 10_000n * C);
    world.setKeyLimit("k1", 300n * C);
    const out = await Promise.allSettled([
      admit("r1", { apiKeyId: "k1" }),
      admit("r2", { apiKeyId: "k1" }),
    ]);
    expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const rejected = out.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as ChargeRejected).code).toBe("key_limit_exceeded");
    expect(world.balance("u1").reserved).toBe(300n * C);
  });

  it("账号月度上限包含在途冻结;同账号不同 Key 共用余额", async () => {
    const { world, admit } = setup("live", 300n * C);
    world.credit("u1", 500n * C);
    world.setAccountLimit("u1", 10_000n * C);
    await admit("r1", { apiKeyId: "k1" });
    await admit("r2", { apiKeyId: "k2" });
    expect(world.charge("r2")?.reservedMicro).toBe((200n * C).toString());
    await expect(admit("r3", { apiKeyId: "k3" })).rejects.toMatchObject({
      code: "insufficient_balance",
    });
  });
});

describe("计费模式按受理时的快照", () => {
  it("试算受理 → 切正式 → 结束 / 清扫补结算:实际扣 0", async () => {
    const { world, state, charging, admit, finish } = setup("trial");
    world.credit("u1", 1000n * C);
    await admit("r1");
    await admit("r2");
    state.mode = "live";
    finish("r1");
    await charging.settle("r1");
    finish("r2", "cancelled");
    expect(await charging.sweep()).toBe(1);
    for (const id of ["r1", "r2"]) expect(world.charge(id)?.chargedMicro).toBe("0");
    expect(world.balance("u1")).toEqual({ available: 1000n * C, reserved: 0n });
  });

  it("正式受理 → 切试算 → 结束 / 清扫补结算:照常扣费,不免单", async () => {
    const { world, state, charging, admit, finish } = setup("live");
    world.credit("u1", 1000n * C);
    await admit("r1");
    await admit("r2");
    state.mode = "trial";
    finish("r1");
    await charging.settle("r1");
    finish("r2", "cancelled");
    await charging.sweep();
    for (const id of ["r1", "r2"]) expect(world.charge(id)?.chargedMicro).toBe(EXPECTED);
    expect(world.balance("u1")).toEqual({ available: 1000n * C - 2n * 57_750_000n, reserved: 0n });
  });
});

describe("运行中追加与停止", () => {
  it("正式:接近冻结额自动追加;追加不成且已超出 → stop", async () => {
    const { world, charging, admit } = setup("live", 30n * C);
    world.credit("u1", 70n * C);
    await admit("r1");
    // 1.1 万输入 = 25.41 积分 ≥ 30 的八成(24) → 追加一份 30
    expect(
      await charging.progress("r1", { input: 11_000, output: 0, cacheRead: 0, cacheWrite: 0 }),
    ).toBe("continue");
    expect(world.charge("r1")?.holds).toHaveLength(2);
    expect(world.balance("u1").reserved).toBe(60n * C);
    // 3 万输入 = 69.3 积分,只剩 10 积分可追加 → 追加 10;再涨到超出 70 且无余额 → stop
    expect(
      await charging.progress("r1", { input: 30_000, output: 0, cacheRead: 0, cacheWrite: 0 }),
    ).toBe("continue");
    expect(world.balance("u1")).toEqual({ available: 0n, reserved: 70n * C });
    expect(
      await charging.progress("r1", { input: 40_000, output: 0, cacheRead: 0, cacheWrite: 0 }),
    ).toBe("stop");
  });

  it("试算:追加永远放行,只记本应拒绝", async () => {
    const { world, charging, admit } = setup("trial", 30n * C);
    world.credit("u1", 30n * C);
    await admit("r1");
    expect(
      await charging.progress("r1", { input: 40_000, output: 0, cacheRead: 0, cacheWrite: 0 }),
    ).toBe("continue");
    expect(world.charge("r1")?.wouldReject).toBe("insufficient_balance");
    expect(world.balance("u1")).toEqual({ available: 30n * C, reserved: 0n });
  });
});

describe("幂等与清扫", () => {
  it("运行未结束不结算;重复结算只生效一次", async () => {
    const { world, charging, admit, finish } = setup("live");
    world.credit("u1", 1000n * C);
    await admit("r1");
    expect(await charging.settle("r1")).toBe("pending");
    finish("r1");
    expect(await charging.settle("r1")).toBe("settled");
    expect(await charging.settle("r1")).toBe("none");
    expect(world.balance("u1").available).toBe(1000n * C - 57_750_000n);
  });

  it("模型不可用:照常建运行(执行时失败),冻结为 0", async () => {
    const world = new InMemoryChargeWorld();
    const { ModelUnavailable } = await import(
      "@/lib/modules/model-gateway/domain/resolve-run-models"
    );
    const charging = new RunCharging({
      mode: async () => "live",
      bind: async () => {
        throw new ModelUnavailable("model_disabled", "停用");
      },
      reserveTargetOf: async () => 300n * C,
      pricedModels: async () => [model],
      transaction: world.transaction,
    });
    const p = await world.transaction((s) =>
      charging.admit(s, { runId: "r1", accountId: "u1", apiKeyId: null, main: "x" }),
    );
    // 不可执行的标记,而不是 null(null 会被当成缺快照的旧任务,执行时现解析)
    expect(p).toEqual({ unavailableAtAdmission: { code: "model_disabled", message: "停用" } });
    expect(world.charge("r1")).toMatchObject({ reservedMicro: "0", holds: [] });
  });
});

describe("取消后迟到的用量", () => {
  const cancelledNoCost = (world: InMemoryChargeWorld, id: string) =>
    world.setRun(id, { status: "cancelled", cost: null, pricing, startedAt: 1 });

  it("正式:清扫时没有用量 → 暂记、释放冻结、标不完整;worker 补记后补扣一次,重复结算不再扣", async () => {
    const { world, charging, admit, finish } = setup("live");
    world.credit("u1", 1000n * C);
    await admit("r1");
    cancelledNoCost(world, "r1");
    expect(await charging.sweep()).toBe(1);
    expect(world.charge("r1")).toMatchObject({
      state: "provisional",
      incomplete: true,
      chargedMicro: "0",
    });
    expect(world.balance("u1")).toEqual({ available: 1000n * C, reserved: 0n });
    // 暂记、用量未到:再清扫、再结算都不动
    expect(await charging.sweep()).toBe(0);
    expect(await charging.settle("r1")).toBe("none");

    finish("r1", "cancelled"); // worker 收尾补记了真实花费
    expect(await charging.settle("r1", { final: true })).toBe("settled");
    expect(world.charge("r1")).toMatchObject({
      state: "settled",
      incomplete: false,
      estimatedMicro: EXPECTED,
      chargedMicro: EXPECTED,
    });
    expect(world.balance("u1")).toEqual({ available: 1000n * C - 57_750_000n, reserved: 0n });
    expect(await charging.settle("r1", { final: true })).toBe("none");
    expect(await charging.sweep()).toBe(0);
    expect(world.balance("u1").available).toBe(1000n * C - 57_750_000n);
  });

  it("worker 那次结算没成功:清扫看到暂记且用量已补记,同样补齐", async () => {
    const { world, charging, admit, finish } = setup("live");
    world.credit("u1", 1000n * C);
    await admit("r1");
    cancelledNoCost(world, "r1");
    await charging.sweep();
    finish("r1", "cancelled");
    expect(await charging.sweep()).toBe(1);
    expect(world.charge("r1")?.chargedMicro).toBe(EXPECTED);
    expect(world.balance("u1").available).toBe(1000n * C - 57_750_000n);
  });

  it("试算:暂记后补上预计消耗,实扣仍为 0", async () => {
    const { world, charging, admit, finish } = setup("trial");
    world.credit("u1", 1000n * C);
    await admit("r1");
    cancelledNoCost(world, "r1");
    await charging.sweep();
    expect(world.charge("r1")).toMatchObject({ state: "provisional", estimatedMicro: "0" });
    finish("r1", "cancelled");
    await charging.settle("r1", { final: true });
    expect(world.charge("r1")).toMatchObject({
      state: "settled",
      estimatedMicro: EXPECTED,
      chargedMicro: "0",
      incomplete: false,
    });
    expect(world.balance("u1")).toEqual({ available: 1000n * C, reserved: 0n });
  });

  it("补扣时余额不够:记欠额、标待核对,实扣 + 欠额 = 应扣", async () => {
    const { world, charging, admit, finish } = setup("live", 30n * C);
    world.credit("u1", 30n * C);
    await admit("r1");
    cancelledNoCost(world, "r1");
    await charging.sweep();
    // 暂记期间余额被别的运行用掉了一部分
    world.setRun("other", { status: "pending", cost: null, pricing, startedAt: null });
    await world.transaction((s) => s.reserveWallet("u1", "x", 10n * C));
    finish("r1", "cancelled");
    await charging.settle("r1", { final: true });
    const c = world.charge("r1");
    expect(c).toMatchObject({ state: "provisional", incomplete: true });
    expect(BigInt(c?.chargedMicro ?? "0") + BigInt(c?.owedMicro ?? "0")).toBe(57_750_000n);
    expect(BigInt(c?.owedMicro ?? "0")).toBeGreaterThan(0n);
  });

  it("从没开始执行就取消:确认没调用模型,直接按 0 结清,不标不完整", async () => {
    const { world, charging, admit } = setup("live");
    world.credit("u1", 1000n * C);
    await admit("r1");
    world.setRun("r1", { status: "cancelled", cost: null, pricing, startedAt: null });
    await charging.sweep();
    expect(world.charge("r1")).toMatchObject({ state: "settled", incomplete: false });
  });

  it("worker 确认用量已定且没有花费:直接结清,不留暂记", async () => {
    const { world, charging, admit } = setup("live");
    world.credit("u1", 1000n * C);
    await admit("r1");
    world.setRun("r1", { status: "failed", cost: null, pricing, startedAt: 1 });
    expect(await charging.settle("r1", { final: true })).toBe("settled");
    expect(world.charge("r1")).toMatchObject({ chargedMicro: "0", incomplete: false });
  });
});

describe("升级遗留的美元上限", () => {
  it("正式:旧上限未按积分重新设置时拒绝(account_limit_pending),不当成不限", async () => {
    const { world, admit } = setup("live");
    world.credit("u1", 1000n * C);
    world.setLegacyPending("u1");
    await expect(admit("r1")).rejects.toMatchObject({ code: "account_limit_pending" });
    expect(world.balance("u1")).toEqual({ available: 1000n * C, reserved: 0n });
  });

  it("试算:照常放行,只记本应拒绝", async () => {
    const { world, admit } = setup("trial");
    world.credit("u1", 1000n * C);
    world.setLegacyPending("u1");
    await admit("r1");
    expect(world.charge("r1")?.wouldReject).toBe("account_limit_pending");
  });

  it("管理员按积分设置了上限之后按新上限执行", async () => {
    const { world, admit } = setup("live");
    world.credit("u1", 1000n * C);
    world.setLegacyPending("u1");
    world.setAccountLimit("u1", 500n * C);
    await admit("r1");
    expect(world.charge("r1")?.reservedMicro).toBe((300n * C).toString());
  });
});

describe("部分计量里有认不出的部分", () => {
  const partialCost = (complete: boolean, input: number) => ({
    input,
    output: 0,
    partial: true,
    metering: {
      source: "sdk_model_usage",
      complete,
      partial: true,
      models: [
        {
          modelId: "up-main",
          inputTokens: input,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
    },
  });

  for (const mode of ["live", "trial"] as const) {
    it(`${mode}:能算的先记上并保持可补结算;补齐明细后只补差额一次`, async () => {
      const { world, charging, admit } = setup(mode);
      world.credit("u1", 1000n * C);
      await admit("r1");
      // 1 万输入能计价(23.1 积分),另有一部分认不出模型
      world.setRun("r1", {
        status: "cancelled",
        cost: partialCost(false, 10000),
        pricing,
        startedAt: 1,
      });
      expect(await charging.settle("r1", { final: true })).toBe("provisional");
      const first = mode === "live" ? 23_100_000n : 0n;
      expect(world.charge("r1")).toMatchObject({
        state: "provisional",
        incomplete: true,
        estimatedMicro: "23100000",
        chargedMicro: first.toString(),
      });
      expect(world.balance("u1")).toEqual({ available: 1000n * C - first, reserved: 0n });
      // 花费没变:清扫不再捞它,结算也不动
      expect(await charging.sweep()).toBe(0);
      expect(await charging.settle("r1", { final: true })).toBe("none");

      // 补齐了明细:2 万输入,完整
      world.setRun("r1", {
        status: "cancelled",
        cost: partialCost(true, 20000),
        pricing,
        startedAt: 1,
      });
      expect(await charging.sweep()).toBe(1);
      const full = mode === "live" ? 46_200_000n : 0n;
      expect(world.charge("r1")).toMatchObject({
        state: "settled",
        incomplete: false,
        estimatedMicro: "46200000",
        chargedMicro: full.toString(),
      });
      expect(await charging.sweep()).toBe(0);
      expect(world.balance("u1")).toEqual({ available: 1000n * C - full, reserved: 0n });
    });
  }

  it("同一运行补扣多次:每次编号不同,不会被钱包当成重复请求漏扣", async () => {
    const { world, charging, admit } = setup("live");
    world.credit("u1", 1000n * C);
    await admit("r1");
    world.setRun("r1", { status: "cancelled", cost: null, pricing, startedAt: 1 });
    await charging.sweep(); // 暂记,0
    world.setRun("r1", {
      status: "cancelled",
      cost: partialCost(false, 10000),
      pricing,
      startedAt: 1,
    });
    await charging.sweep(); // 补 23.1
    world.setRun("r1", {
      status: "cancelled",
      cost: partialCost(true, 20000),
      pricing,
      startedAt: 1,
    });
    await charging.sweep(); // 再补 23.1
    expect(world.charge("r1")).toMatchObject({ state: "settled", chargedMicro: "46200000" });
    expect(world.balance("u1").available).toBe(1000n * C - 46_200_000n);
  });
});

describe("补结算以真实已扣为基准(费用先往下、再往上修正)", () => {
  // 输入 2310 积分/百万 token:4 万 = 92.4,3 万 = 69.3,5 万 = 115.5
  const cost = (input: number, complete: boolean) => ({
    input,
    output: 0,
    partial: true,
    metering: {
      source: "sdk_model_usage",
      complete,
      partial: true,
      models: [
        {
          modelId: "up-main",
          inputTokens: input,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
    },
  });
  const A = 92_400_000n;
  const B = 69_300_000n;
  const D = 115_500_000n;

  it("正式:暂记 92.4 → 修正为 69.3(不倒推、不退款,标多扣待核对)→ 补齐 115.5 只补 23.1 → 重复结算不再扣", async () => {
    const { world, charging, admit } = setup("live");
    world.credit("u1", 1000n * C);
    await admit("r1");
    const set = (c: unknown) =>
      world.setRun("r1", { status: "cancelled", cost: c, pricing, startedAt: 1 });
    const check = (charged: bigint, estimated: bigint, state: string) => {
      expect(world.charge("r1")).toMatchObject({
        chargedMicro: charged.toString(),
        estimatedMicro: estimated.toString(),
        state,
      });
      // 记录的实扣 = 钱包真正扣掉的 = 余额减少的
      expect(world.deducted("u1")).toBe(charged);
      expect(world.balance("u1")).toEqual({ available: 1000n * C - charged, reserved: 0n });
    };

    set(cost(40000, false));
    expect(await charging.settle("r1", { final: true })).toBe("provisional");
    check(A, A, "provisional");

    set(cost(30000, true)); // 往下修正
    expect(await charging.sweep()).toBe(1);
    check(A, B, "provisional"); // 实扣仍是 92.4,多扣 23.1 待核对
    expect(world.charge("r1")).toMatchObject({ incomplete: true, owedMicro: null });
    expect(await charging.sweep()).toBe(0); // 没变化不再处理

    set(cost(50000, true)); // 再往上补齐
    expect(await charging.sweep()).toBe(1);
    check(D, D, "settled"); // 只补了 115.5 − 92.4 = 23.1,不是 115.5 − 69.3 = 46.2
    expect(world.charge("r1")?.incomplete).toBe(false);

    expect(await charging.sweep()).toBe(0);
    expect(await charging.settle("r1", { final: true })).toBe("none");
    check(D, D, "settled");
  });

  it("试算:同样的修正过程只更新预计消耗,钱包一分不动", async () => {
    const { world, charging, admit } = setup("trial");
    world.credit("u1", 1000n * C);
    await admit("r1");
    // 中间一步仍不完整(保持暂记);完整之后才结清
    for (const [c, est] of [
      [cost(40000, false), A],
      [cost(30000, false), B],
      [cost(50000, true), D],
    ] as const) {
      world.setRun("r1", { status: "cancelled", cost: c, pricing, startedAt: 1 });
      await charging.settle("r1", { final: true });
      expect(world.charge("r1")).toMatchObject({
        estimatedMicro: est.toString(),
        chargedMicro: "0",
      });
    }
    expect(world.deducted("u1")).toBe(0n);
    expect(world.balance("u1")).toEqual({ available: 1000n * C, reserved: 0n });
  });
});

describe("欠款补扣", () => {
  it("实际费用超过冻结额 → 余额不足留下欠额 → 充值 → 补结算只补一次 → 重复执行不再扣", async () => {
    // 单次冻结 30,余额 50:实际 57.75,冻结扣 30,超出的 27.75 余额只剩 20 补不上
    const { world, charging, admit, finish } = setup("live", 30n * C);
    world.credit("u1", 50n * C);
    await admit("r1");
    finish("r1");
    expect(await charging.settle("r1", { final: true })).toBe("provisional");
    expect(world.charge("r1")).toMatchObject({
      state: "provisional",
      incomplete: true,
      chargedMicro: (30n * C).toString(),
      owedMicro: "27750000",
    });
    expect(world.deducted("u1")).toBe(30n * C);
    expect(world.balance("u1")).toEqual({ available: 20n * C, reserved: 0n });

    // 余额还不够:清扫不捞它,重复结算也补不上、不重复记欠
    expect(await charging.sweep()).toBe(0);
    await charging.settle("r1", { final: true });
    expect(world.charge("r1")).toMatchObject({ owedMicro: "27750000", chargedMicro: "30000000" });

    // 充值后清扫补扣
    world.credit("u1", 100n * C);
    expect(await charging.sweep()).toBe(1);
    expect(world.charge("r1")).toMatchObject({
      state: "settled",
      incomplete: false,
      chargedMicro: "57750000",
      owedMicro: null,
    });
    expect(world.deducted("u1")).toBe(57_750_000n);
    expect(world.balance("u1")).toEqual({ available: 150n * C - 57_750_000n, reserved: 0n });

    // 重复执行:不再扣
    expect(await charging.sweep()).toBe(0);
    expect(await charging.settle("r1", { final: true })).toBe("none");
    expect(world.deducted("u1")).toBe(57_750_000n);
    expect(world.balance("u1").available).toBe(150n * C - 57_750_000n);
  });
});

describe("月度上限计入已确认的欠额", () => {
  const window = monthWindowUtc(Date.now());
  for (const scope of ["account", "key"] as const) {
    it(`${scope === "account" ? "账号" : "Key"}:实际超限并留欠 → 再次发起被拒;充值补扣后月度已用不变、仍被拒`, async () => {
      // 上限 50;单次冻结 30;余额 50。实际 57.75:冻结扣 30,欠 27.75,钱包剩 20
      const { world, charging, admit, finish } = setup("live", 30n * C);
      world.credit("u1", 50n * C);
      if (scope === "account") world.setAccountLimit("u1", 50n * C);
      else world.setKeyLimit("k1", 50n * C);
      const apiKeyId = scope === "key" ? "k1" : null;
      const used = () =>
        world.transaction((s) =>
          s.monthUsage(
            scope === "account"
              ? { accountId: "u1", mode: "live", ...window }
              : { apiKeyId: "k1", mode: "live", ...window },
          ),
        );
      const code = scope === "account" ? "account_limit_exceeded" : "key_limit_exceeded";

      await admit("r1", { apiKeyId });
      finish("r1");
      await charging.settle("r1", { final: true });
      expect(world.charge("r1")).toMatchObject({ chargedMicro: "30000000", owedMicro: "27750000" });
      expect(await used()).toBe(57_750_000n); // 实扣 30 + 欠 27.75,不是只算 30

      await expect(admit("r2", { apiKeyId })).rejects.toMatchObject({ code });
      expect(world.charge("r2")).toBeNull();
      expect(world.balance("u1")).toEqual({ available: 20n * C, reserved: 0n });

      // 充值补扣:欠额转实扣,月度已用不变
      world.credit("u1", 100n * C);
      await charging.sweep();
      expect(world.charge("r1")).toMatchObject({ chargedMicro: "57750000", owedMicro: null });
      expect(await used()).toBe(57_750_000n);
      await expect(admit("r3", { apiKeyId })).rejects.toMatchObject({ code });
    });
  }
});

describe("跨月运行:月度占用按受理月份归属", () => {
  const JAN_31 = Date.UTC(2026, 0, 31, 23, 30);
  const FEB_1 = Date.UTC(2026, 1, 1, 0, 30);
  for (const scope of ["account", "key"] as const) {
    it(`${scope === "account" ? "账号" : "Key"}:月底受理 → 推进到下月 → 连续追加冻结,追加记在受理月份且受它的上限约束`, async () => {
      const clock = { t: JAN_31 };
      const { world, charging, admit } = setup("live", 30n * C, () => clock.t);
      world.credit("u1", 1000n * C); // 余额充足,只有月度上限能拦
      if (scope === "account") world.setAccountLimit("u1", 50n * C);
      else world.setKeyLimit("k1", 50n * C);
      const apiKeyId = scope === "key" ? "k1" : null;
      const usage = (at: number) =>
        world.transaction((s) =>
          s.monthUsage({
            ...(scope === "account" ? { accountId: "u1" } : { apiKeyId: "k1" }),
            mode: "live",
            ...monthWindowUtc(at),
          }),
        );

      await admit("r1", { apiKeyId }); // 1 月受理,冻结 30
      clock.t = FEB_1; // 运行跨进 2 月
      expect(await charging.topUp("r1")).toBe(true); // 1 月只剩 20:只追加 20
      expect(await charging.topUp("r1")).toBe(false); // 1 月已满:不再追加
      expect(await charging.topUp("r1")).toBe(false);

      expect(world.charge("r1")?.reservedMicro).toBe((50n * C).toString());
      expect(world.balance("u1")).toEqual({ available: 950n * C, reserved: 50n * C });
      // 追加的冻结没有从统计里消失:全部记在 1 月
      expect(await usage(JAN_31)).toBe(50n * C);
      expect(await usage(FEB_1)).toBe(0n);

      // 2 月受理的新运行用 2 月的额度
      await admit("r2", { apiKeyId });
      expect(world.charge("r2")?.reservedMicro).toBe((30n * C).toString());
      expect(await usage(FEB_1)).toBe(30n * C);
      expect(await usage(JAN_31)).toBe(50n * C);
    });
  }
});
