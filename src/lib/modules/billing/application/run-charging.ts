// 运行计费:受理时冻结、运行中追加、结束时结算、清扫补结算。
//
// 计费模式在受理时锁进 run_charges.mode,之后只读它 —— 全局设置只决定新受理的运行。
// 试算(trial):余额与额度照常算,不够只记"本应拒绝"并放行;冻结只记在 run_charges,
// 钱包不动;结束全额释放,实际扣除恒为 0,另记预计消耗。
// 正式(live):不够就拒绝;冻结落在钱包里;结束按锁定价目与实际用量扣除。
import type { ModelMetering } from "@/lib/modules/agent-engine/domain/model-usage";
import type { Capability } from "@/lib/modules/capabilities/domain/catalog";
import type { RunModelBinding } from "@/lib/modules/model-gateway/domain/resolve-run-models";
import { ModelUnavailable } from "@/lib/modules/model-gateway/domain/resolve-run-models";
import { estimateRunCredits } from "@/lib/modules/usage/domain/estimate";
import { BrandedError, type ModelRef, type PinnedPricing, type RunPricing } from "@/lib/shared";
import {
  type BillingMode,
  DEFAULT_RESERVE_MICRO,
  type HoldDecision,
  type HoldRejection,
  REJECTION_MESSAGE,
  decideHold,
  monthWindowUtc,
  planSettlement,
  remaining,
} from "../domain/run-charge";
import { BillingError } from "../ports";
import type { ChargeTransaction, RunChargeStore } from "../run-charge-ports";

/** 正式模式下余额或额度不足,拒绝受理。路由翻成 402。 */
export class ChargeRejected extends BrandedError {
  static readonly brand = Symbol.for("owa.error.ChargeRejected");
  constructor(readonly code: HoldRejection) {
    super(REJECTION_MESSAGE[code]);
  }
}

export interface AdmitRequest {
  runId: string;
  accountId: string;
  apiKeyId: string | null;
  main: ModelRef;
  override?: ModelRef;
  subagents?: { name: string; model?: ModelRef }[];
}

export interface RunChargingDeps {
  mode: () => Promise<BillingMode>;
  bind: (req: {
    main: ModelRef;
    override?: ModelRef;
    subagents?: AdmitRequest["subagents"];
  }) => Promise<RunModelBinding>;
  /** 主模型的单次冻结额;模型没配时用默认值 */
  reserveTargetOf: (capabilityId: string) => Promise<bigint | null>;
  /** 按运行锁定的价目版本取模型快照 */
  pricedModels: (pricing: RunPricing) => Promise<Capability[] | null>;
  transaction: ChargeTransaction;
  now?: () => number;
}

const TERMINAL = new Set(["success", "failed", "cancelled"]);

export { monthStartUtc } from "../domain/run-charge";

export type UsageTokens = { input: number; output: number; cacheRead: number; cacheWrite: number };

interface LiveRun {
  /** 已冻结(用于判断是否该追加) */
  reserved: bigint;
  /** 每类 token 在本次运行各模型里最贵的单价(每 token 微积分 × units 的分子分母) */
  rates: { meter: keyof UsageTokens; micro: bigint; units: bigint }[];
  /** 上次尝试追加时的预计消耗,避免每个事件都去数据库 */
  lastAttempt: bigint;
}

const METER_OF: Record<string, keyof UsageTokens> = {
  input_token: "input",
  output_token: "output",
  cache_read_token: "cacheRead",
  cache_write_token: "cacheWrite",
};

export class RunCharging {
  private readonly live = new Map<string, LiveRun>();
  private readonly now: () => number;

  constructor(private readonly deps: RunChargingDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * 受理:在调用方的事务里锁账户、算额度、冻结、写 run_charges。返回要锁进运行记录的计价上下文。
   * 模型此刻不可用不在这里拒绝 —— 运行照常创建,执行时如实失败(与之前的行为一致),冻结为 0。
   */
  async admit(store: RunChargeStore, req: AdmitRequest): Promise<PinnedPricing> {
    const mode = await this.deps.mode();
    let binding: RunModelBinding | null = null;
    let unavailable: ModelUnavailable | null = null;
    try {
      binding = await this.deps.bind(req);
    } catch (err) {
      if (!(err instanceof ModelUnavailable)) throw err;
      unavailable = err;
    }
    const target = binding
      ? ((await this.deps.reserveTargetOf(binding.main.capabilityId)) ?? DEFAULT_RESERVE_MICRO)
      : 0n;
    const wallet = await store.lockAccount(req.accountId);
    const decision: HoldDecision = binding
      ? await this.decide(store, {
          mode,
          accountId: req.accountId,
          apiKeyId: req.apiKeyId,
          target,
          available: BigInt(wallet.availableMicroCredits),
          topUp: false,
          // 受理:记在本月
          at: this.now(),
        })
      : { amount: 0n, rejection: null };

    if (decision.rejection && mode === "live") throw new ChargeRejected(decision.rejection);

    const holds: { id: string; amount: string }[] = [];
    let reserved = decision.amount;
    if (mode === "live" && decision.amount > 0n) {
      const id = `run:${req.runId}:0`;
      await store.reserveWallet(req.accountId, id, decision.amount);
      holds.push({ id, amount: decision.amount.toString() });
    }
    // 试算本应拒绝:按完整目标额记在试算账上,统计"若是正式会怎样"
    if (mode === "trial" && decision.rejection) reserved = target;

    await store.insert({
      runId: req.runId,
      accountId: req.accountId,
      apiKeyId: req.apiKeyId,
      mode,
      reservedMicro: reserved.toString(),
      holds,
      estimatedMicro: null,
      chargedMicro: null,
      owedMicro: null,
      state: "open",
      wouldReject: mode === "trial" ? decision.rejection : null,
      incomplete: false,
      settledCostDigest: null,
      createdAt: this.now(),
      settledAt: null,
    });
    if (binding) return binding.pricing;
    // 模型此刻不可用:运行照常建(执行时如实失败),但标成不可执行 —— 它没过余额与额度检查,
    // 排队期间模型被重新启用也不能让它去调用模型
    return {
      unavailableAtAdmission: {
        code: unavailable?.code ?? "model_not_found",
        message: unavailable?.message ?? "模型不可用",
      },
    };
  }

  private async decide(
    store: RunChargeStore,
    q: {
      mode: BillingMode;
      accountId: string;
      apiKeyId: string | null;
      target: bigint;
      available: bigint;
      topUp: boolean;
      /** 这笔冻结归属的时刻:决定按哪个自然月统计与检查 */
      at: number;
    },
  ): Promise<HoldDecision> {
    const { since, until } = monthWindowUtc(q.at);
    const account = await store.accountLimit(q.accountId);
    // 旧美元上限还没按积分重新设置:不能当成不限,也不能擅自换算
    if (account.pending) return { amount: 0n, rejection: "account_limit_pending" };
    const accountRemaining = remaining(
      account.limit,
      await store.monthUsage({ accountId: q.accountId, mode: q.mode, since, until }),
    );
    const keyRemaining = q.apiKeyId
      ? remaining(
          await store.keyLimit(q.apiKeyId),
          await store.monthUsage({ apiKeyId: q.apiKeyId, mode: q.mode, since, until }),
        )
      : null;
    const available =
      q.mode === "trial" ? q.available - (await store.openTrialReserved(q.accountId)) : q.available;
    return decideHold({
      target: q.target,
      available,
      accountRemaining,
      keyRemaining,
      topUp: q.topUp,
    });
  }

  /** 运行中追加一份冻结。试算永远放行(只记本应拒绝);正式不够返回 false。 */
  async topUp(runId: string): Promise<boolean> {
    return this.deps.transaction(async (store) => {
      const c = await store.get(runId, true);
      if (!c || c.state !== "open") return true;
      const run = await store.runForSettle(runId);
      const mainId = run?.pricing?.binding?.main;
      const target = mainId
        ? ((await this.deps.reserveTargetOf(mainId)) ?? DEFAULT_RESERVE_MICRO)
        : DEFAULT_RESERVE_MICRO;
      const wallet = await store.lockAccount(c.accountId);
      const decision = await this.decide(store, {
        mode: c.mode,
        accountId: c.accountId,
        apiKeyId: c.apiKeyId,
        target,
        available: BigInt(wallet.availableMicroCredits),
        topUp: true,
        // 追加:记在受理那个月(这条记录归属的月份),按那个月的额度检查 —— 跨月运行也一样
        at: c.createdAt,
      });
      if (c.mode === "trial") {
        const add = decision.rejection ? target : decision.amount;
        await store.update(runId, {
          reservedMicro: (BigInt(c.reservedMicro) + add).toString(),
          ...(decision.rejection && !c.wouldReject ? { wouldReject: decision.rejection } : {}),
        });
        this.bump(runId, add);
        return true;
      }
      if (decision.rejection || decision.amount === 0n) return false;
      const id = `run:${runId}:${c.holds.length}`;
      await store.reserveWallet(c.accountId, id, decision.amount);
      await store.update(runId, {
        reservedMicro: (BigInt(c.reservedMicro) + decision.amount).toString(),
        holds: [...c.holds, { id, amount: decision.amount.toString() }],
      });
      this.bump(runId, decision.amount);
      return true;
    });
  }

  private bump(runId: string, add: bigint) {
    const l = this.live.get(runId);
    if (l) l.reserved += add;
  }

  /**
   * 运行中每次模型请求返回后调用(token 为本运行累计)。用量事件不带模型,按本次运行各模型里
   * 最贵的单价估上界,保证不少冻。接近已冻结额就追加;正式模式追加失败且已超出 → "stop"。
   */
  async progress(runId: string, tokens: UsageTokens): Promise<"continue" | "stop"> {
    let l = this.live.get(runId);
    if (!l) {
      const loaded = await this.loadLive(runId);
      if (!loaded) return "continue";
      l = loaded;
      this.live.set(runId, l);
    }
    let spent = 0n;
    for (const r of l.rates) {
      const q = BigInt(Math.max(0, Math.floor(tokens[r.meter])));
      spent += (q * r.micro + r.units - 1n) / r.units;
    }
    // 用到八成就提前追加;同一档消耗只尝试一次
    if (spent * 10n < l.reserved * 8n || spent <= l.lastAttempt) return "continue";
    l.lastAttempt = spent;
    const ok = await this.topUp(runId);
    if (ok) return "continue";
    return spent >= l.reserved ? "stop" : "continue";
  }

  private async loadLive(runId: string): Promise<LiveRun | null> {
    const snap = await this.deps.transaction(async (store) => {
      const c = await store.get(runId);
      const run = await store.runForSettle(runId);
      return c && c.state === "open" && run?.pricing ? { c, pricing: run.pricing } : null;
    });
    if (!snap) return null;
    const models = (await this.deps.pricedModels(snap.pricing)) ?? [];
    const best = new Map<keyof UsageTokens, { micro: bigint; units: bigint }>();
    for (const m of models) {
      for (const r of m.rates) {
        const meter = METER_OF[r.meter];
        if (!meter) continue;
        const cand = { micro: BigInt(r.microCredits), units: BigInt(r.units) };
        const cur = best.get(meter);
        if (!cur || cand.micro * cur.units > cur.micro * cand.units) best.set(meter, cand);
      }
    }
    return {
      reserved: BigInt(snap.c.reservedMicro),
      rates: [...best].map(([meter, v]) => ({ meter, ...v })),
      lastAttempt: 0n,
    };
  }

  /**
   * 结算(幂等)。按 run_charges 锁定的模式与运行锁定的价目版本:
   * 试算全额释放、实际扣 0;正式按实际扣除,超出冻结的另行补扣,补不上记欠额。
   *
   * final:调用方确认用量已定(worker 写完结果、补记完花费之后调用)。清扫不是 final ——
   * 它看到"跑过却没有花费"时分不清是"没调用模型"还是"用量还没补记"(取消后 worker
   * 还在收尾,或 worker 失联),只能先释放冻结、暂记为 provisional,等迟到的用量补结算。
   * 从没开始执行的运行确认没有调用模型,直接按 0 结清。
   *
   * 有花费却不能完整计价(部分用量里认不出模型、缺价目)同样只暂记:能算的先扣/记上,
   * 花费之后变了(按指纹判断)再补差额,不能当成已结清。
   */
  async settle(
    runId: string,
    opts: { final?: boolean } = {},
  ): Promise<"settled" | "provisional" | "pending" | "none"> {
    const result = await this.deps.transaction(async (store) => {
      const c = await store.get(runId, true);
      if (!c || c.state === "settled") return "none" as const;
      const run = await store.runForSettle(runId);
      if (!run || !TERMINAL.has(run.status)) return "pending" as const;

      const cost = (run.cost ?? null) as { metering?: ModelMetering } | null;
      const digest = run.costDigest ?? null;
      // 暂记之后花费没变、也没有欠款要补:没有新的信息,保持原样
      // (worker 确认"没有花费 = 没有用量"的除外)。有欠款时不受指纹限制 —— 充值后要能补扣
      const owing = BigInt(c.owedMicro ?? "0") > 0n;
      if (
        c.state === "provisional" &&
        digest === c.settledCostDigest &&
        !owing &&
        !(opts.final && !cost)
      ) {
        return "none" as const;
      }
      // 跑过却没有花费,而调用方又不能确认用量已定:可能是还没补记
      const usageUnknown = !cost && run.startedAt !== null && !opts.final;

      let estimated = 0n;
      // 有花费却不能完整计价(没有按模型的计量、认不出模型、缺价目):能算的先记上,其余待补
      let unresolved = false;
      if (cost) {
        const models = run.pricing ? await this.deps.pricedModels(run.pricing) : null;
        if (cost.metering && models) {
          const est = estimateRunCredits(cost.metering, models);
          estimated = BigInt(est.totalMicroCredits);
          unresolved = !est.complete || est.models.some((m) => m.unpriced);
        } else {
          unresolved = true;
        }
      }
      const pending = usageUnknown || unresolved;
      const nextState = pending ? ("provisional" as const) : ("settled" as const);

      if (c.mode === "trial") {
        await store.update(runId, {
          estimatedMicro: estimated.toString(),
          chargedMicro: "0",
          state: nextState,
          incomplete: pending,
          settledCostDigest: digest,
          settledAt: this.now(),
        });
        return nextState;
      }

      // 实扣只按真正成功的扣款累计,绝不由预计费用倒推 —— 预计费用修正(含往下修正)时,
      // 倒推出来的"实扣"与钱包不一致,下一次补扣又以错误的基准算差额,就会多扣用户的钱
      let paid = 0n;
      const charge = async (id: string, amount: bigint) => {
        if (amount <= 0n) return;
        try {
          await store.lockAccount(c.accountId);
          await store.reserveWallet(c.accountId, id, amount);
          await store.settleWallet(c.accountId, id, amount);
          paid += amount;
        } catch (err) {
          // 余额不够:这次没扣成,差额记为欠额,下次结算再试
          if (!(err instanceof BillingError) || err.code !== "insufficient_balance") throw err;
        }
      };
      if (c.state === "open") {
        // 首次结算:按应扣额摊到各笔冻结上,其余释放;超出部分另行补扣
        const plan = planSettlement(estimated, c.holds);
        for (const sl of plan.settles) {
          await store.settleWallet(c.accountId, sl.id, sl.charged);
          paid += sl.charged;
        }
        await charge(`run:${runId}:over`, plan.over);
      } else {
        // 暂记之后补结算:冻结早已释放,以真实已扣为基准只补正差额。
        // 编号带上已扣金额 —— 同一运行可能补好几次,编号相同会被钱包当成重复请求
        paid = BigInt(c.chargedMicro ?? "0");
        await charge(`run:${runId}:late:${paid}`, estimated - paid);
      }
      // 欠额 = 应扣但没扣成的(余额不足):保持可重试,充值后由清扫补扣。
      // 多扣 = 已扣超过修正后的应扣(暂不自动退款,停在暂记待核对)
      const owed = estimated > paid ? estimated - paid : 0n;
      const overcharged = paid > estimated ? paid - estimated : 0n;
      const state =
        pending || owed > 0n || overcharged > 0n ? ("provisional" as const) : ("settled" as const);
      await store.update(runId, {
        estimatedMicro: estimated.toString(),
        chargedMicro: paid.toString(),
        owedMicro: owed > 0n ? owed.toString() : null,
        state,
        incomplete: pending || owed > 0n || overcharged > 0n,
        settledCostDigest: digest,
        settledAt: this.now(),
      });
      return state;
    });
    if (result !== "pending") this.live.delete(runId);
    return result;
  }

  /** 清扫:运行已结束但计费还开着的(取消、回收孤儿等不经 worker 的路径,或结算时出错)逐个补结算 */
  async sweep(limit = 50): Promise<number> {
    const ids = await this.deps.transaction((store) => store.openOfFinishedRuns(limit));
    let n = 0;
    for (const id of ids) {
      const r = await this.settle(id);
      if (r === "settled" || r === "provisional") n++;
    }
    return n;
  }
}
