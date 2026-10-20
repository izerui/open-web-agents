// 运行计费端到端:余额或额度不足返回 402;有余额按实际用量扣除;五个入口都计费。
// 需要带 worker 的服务与可写的测试库(OWA_E2E_DATABASE_URL = owa_test):要临时设管理员、读 run_charges。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeGateway } from "../scripts/sdk-probe/fake-gateway.mjs";
import { BASE, Client, newUser, serverUp } from "./client";

const databaseUrl = process.env.OWA_E2E_DATABASE_URL;
if (databaseUrl && !/test/i.test(new URL(databaseUrl).pathname)) {
  throw new Error("run charging E2E requires a dedicated test database");
}

const C = 1_000_000n;
type Charge = {
  mode: string;
  state: string;
  estimated_micro: string | null;
  charged_micro: string | null;
  account_id: string;
};
type Balance = { availableMicroCredits: string; reservedMicroCredits: string };
type RunBody = {
  taskId?: string;
  status?: string;
  code?: string;
  cost?: { creditEstimate?: { totalMicroCredits: string } } | null;
};

describe.skipIf(!databaseUrl)("运行计费", () => {
  let admin: Client;
  let promotedId: string | undefined;
  let gw: { baseUrl: string; close: () => void; seenRequests: unknown[] };
  let modelId = "";
  /** 模型当前定义(停用 / 启用都要带上最新版本号) */
  let modelDef: Record<string, unknown> & { id: string; version: number };
  const tag = Date.now();

  async function database() {
    const { createConnection } = await import("mysql2/promise");
    if (!databaseUrl) throw new Error("missing test database");
    return createConnection(databaseUrl);
  }

  /** 等计费结算(worker 结束后结算;取消等路径由清扫补上) */
  async function settled(runId: string): Promise<Charge> {
    const db = await database();
    try {
      for (let i = 0; i < 120; i++) {
        const [rows] = await db.execute("SELECT * FROM run_charges WHERE run_id = ?", [runId]);
        const c = (rows as Charge[])[0];
        if (c?.state === "settled") return c;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error(`run ${runId} 计费未结算`);
    } finally {
      await db.end();
    }
  }

  async function chargeRow(runId: string): Promise<Charge | null> {
    const db = await database();
    try {
      for (let i = 0; i < 40; i++) {
        const [rows] = await db.execute("SELECT * FROM run_charges WHERE run_id = ?", [runId]);
        const c = (rows as Charge[])[0];
        if (c) return c;
        await new Promise((r) => setTimeout(r, 250));
      }
      return null;
    } finally {
      await db.end();
    }
  }

  const credit = async (accountId: string, credits: string) => {
    const r = await admin.post(
      "/api/billing/credits",
      { accountId, credits, reason: "E2E 计费" },
      { "Idempotency-Key": `e2e-charge-${accountId}-${credits}-${Date.now()}` },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  };

  /** 新用户 + 用计价模型的智能体 + 一个会话 */
  async function customer(label: string, credits?: string) {
    const client = await newUser(`charge-${label}`, { credits: 0n });
    const accountId = (await client.get<{ user: { id: string } }>("/api/auth")).body.user.id;
    if (credits) await credit(accountId, credits);
    const a = await client.post<{ agent?: { id: string } }>("/api/agents", {
      name: `计费-${label}-${tag}`,
      config: { systemPrompt: "简短回答", model: modelId, maxTurns: 2 },
    });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const agentId = a.body.agent?.id ?? "";
    const session = async () =>
      (await client.post<{ session?: { id: string } }>("/api/sessions", { agentId })).body.session
        ?.id ?? "";
    const balance = async () =>
      (await client.get<{ balance: Balance }>("/api/billing")).body.balance;
    return { client, accountId, agentId, session, balance };
  }

  const chat = (client: Client, sessionId: string) =>
    client.post<RunBody>(`/api/sessions/${sessionId}/run`, { prompt: "你好", stream: false });

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("server unavailable");
    // 每轮慢一点回,贴近真实上游
    gw = await startFakeGateway(
      Array.from({ length: 400 }, () => ({ text: "好的", delayMs: 600 })),
    );
    admin = await newUser("charge-admin");
    const me = await admin.get<{ user: { id: string; role: string } }>("/api/auth");
    if (me.body.user.role !== "admin") {
      promotedId = me.body.user.id;
      const db = await database();
      try {
        await db.execute("UPDATE users SET role = 'admin' WHERE id = ?", [promotedId]);
      } finally {
        await db.end();
      }
    }
    const p = await admin.post<{ provider: { id: string } }>("/api/admin/providers", {
      definition: {
        name: `计费测试-${tag}`,
        enabled: true,
        endpoints: { llm: { protocol: "anthropic", baseUrl: gw.baseUrl } },
      },
      apiKey: `sk-e2e-charge-${tag}`,
    });
    expect(p.status).toBe(201);
    // 成本单价较高,让几十个 token 也有可见的非零消耗
    const yuan = (v: string) => String(Math.round(Number(v) * 100_000_000));
    const m = await admin.post<{ model: typeof modelDef }>("/api/admin/models", {
      expectedVersion: null,
      definition: {
        name: `计费模型-${tag}`,
        kind: "llm",
        modelId: `e2e-charge-${tag}`,
        enabled: true,
        acceptsImages: false,
        providerId: p.body.provider.id,
        markupBp: 1000,
        reserveMicroCredits: (50n * C).toString(),
        costRates: [
          { meter: "input_token", units: "1000000", microCredits: yuan("3000") },
          { meter: "output_token", units: "1000000", microCredits: yuan("15000") },
          { meter: "cache_read_token", units: "1000000", microCredits: yuan("300") },
          { meter: "cache_write_token", units: "1000000", microCredits: yuan("3750") },
        ],
        rates: [],
      },
    });
    expect(m.status, JSON.stringify(m.body)).toBe(201);
    modelId = m.body.model.id;
    modelDef = m.body.model;
  });

  afterAll(async () => {
    gw?.close();
    if (promotedId) {
      const db = await database();
      try {
        await db.execute("UPDATE users SET role = 'user' WHERE id = ?", [promotedId]);
      } finally {
        await db.end();
      }
    }
  });

  it(
    "余额不足时对话(阻塞与流式)、调用都返回 402;有余额按实际扣除,冻结全部释放",
    { timeout: 60_000 },
    async () => {
      {
        const poor = await customer("live-poor");
        const s = await poor.session();
        const blocking = await chat(poor.client, s);
        expect(blocking.status).toBe(402);
        expect(blocking.body.code).toBe("insufficient_balance");
        const stream = await fetch(`${BASE}/api/sessions/${s}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: poor.client.cookieHeader() },
          body: JSON.stringify({ prompt: "你好" }),
        });
        expect(stream.status).toBe(402);
        expect(((await stream.json()) as { code: string }).code).toBe("insufficient_balance");
        const key = (
          await poor.client.post<{ plaintext: string }>("/api/keys", {
            name: "poor",
            agentId: poor.agentId,
          })
        ).body.plaintext;
        const invoked = await new Client("charge-poor-api").post<{ code?: string }>(
          `/api/agents/${poor.agentId}/invoke`,
          { input: "hi" },
          { "X-Api-Key": key },
        );
        expect(invoked.status).toBe(402);
        expect(invoked.body.code).toBe("insufficient_balance");

        const rich = await customer("live-rich", "1000");
        const r = await chat(rich.client, await rich.session());
        expect(r.body.status, JSON.stringify(r.body)).toBe("success");
        const c = await settled(r.body.taskId ?? "");
        const estimate = BigInt(r.body.cost?.creditEstimate?.totalMicroCredits ?? "0");
        expect(estimate).toBeGreaterThan(0n);
        expect(c).toMatchObject({ mode: "live", charged_micro: estimate.toString() });
        expect(await rich.balance()).toEqual(
          expect.objectContaining({
            availableMicroCredits: (1000n * C - estimate).toString(),
            reservedMicroCredits: "0",
          }),
        );
      }
    },
  );

  it(
    "同一幂等键并发两次,余额或 Key 额度只够一次 —— 两次都拿到同一 taskId,只冻结一次",
    { timeout: 60_000 },
    async () => {
      {
        const sameKeyTwice = async (
          who: Awaited<ReturnType<typeof customer>>,
          keyLimit?: string,
        ) => {
          const issued = await who.client.post<{ plaintext: string; key: { id: string } }>(
            "/api/keys",
            { name: "idem", agentId: who.agentId },
          );
          if (keyLimit) {
            const r = await who.client.patch(`/api/keys?id=${issued.body.key.id}`, {
              monthlyLimitCredits: keyLimit,
            });
            expect(r.status).toBe(200);
          }
          const api = new Client(`idem-${who.accountId}`);
          const headers = { "X-Api-Key": issued.body.plaintext, "Idempotency-Key": `same-${tag}` };
          const out = await Promise.all([
            api.post<{ taskId?: string; code?: string }>(
              `/api/agents/${who.agentId}/invoke`,
              { input: "同一个请求" },
              headers,
            ),
            api.post<{ taskId?: string; code?: string }>(
              `/api/agents/${who.agentId}/invoke`,
              { input: "同一个请求" },
              headers,
            ),
          ]);
          for (const r of out) expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
          expect(out[0].body.taskId).toBeTruthy();
          expect(out[1].body.taskId).toBe(out[0].body.taskId);
          return out[0].body.taskId ?? "";
        };

        // 余额只够冻结一次:模型单次冻结 50,冻完剩 10,低于 20 的门槛
        const once = await customer("idem-balance", "60");
        const t1 = await sameKeyTwice(once);
        const db = await database();
        try {
          const [rows] = await db.execute(
            "SELECT COUNT(*) AS n FROM run_charges WHERE account_id = ?",
            [once.accountId],
          );
          expect(Number((rows as { n: number }[])[0]?.n)).toBe(1);
        } finally {
          await db.end();
        }
        await settled(t1);

        // Key 月度上限只够一次
        const keyed = await customer("idem-key", "1000");
        await settled(await sameKeyTwice(keyed, "50"));
      }
    },
  );

  it("升级遗留的美元上限:管理员可见待处理;拒绝受理;按积分设置后恢复", async () => {
    const u = await customer("legacy", "1000");
    const db = await database();
    try {
      // 升级前配置过美元上限的账号(0047 只加了积分上限列,值为 NULL)
      await db.execute(
        "UPDATE users SET monthly_quota_micro_usd = 5000000, monthly_limit_micro_credits = NULL WHERE id = ?",
        [u.accountId],
      );
    } finally {
      await db.end();
    }
    type Row = {
      id: string;
      legacyLimitMicroUsd: number | null;
      monthlyLimitMicroCredits: string | null;
    };
    const row = async () =>
      (await admin.get<{ accounts: Row[] }>("/api/admin/accounts")).body.accounts.find(
        (a) => a.id === u.accountId,
      );
    expect((await row())?.legacyLimitMicroUsd).toBe(5_000_000);

    {
      const live = await chat(u.client, await u.session());
      expect(live.status).toBe(402);
      expect(live.body.code).toBe("account_limit_pending");

      const set = await admin.patch("/api/admin/accounts", {
        id: u.accountId,
        monthlyLimitCredits: "500",
      });
      expect(set.status).toBe(200);
      expect(await row()).toMatchObject({
        legacyLimitMicroUsd: null,
        monthlyLimitMicroCredits: (500n * C).toString(),
      });
      const after = await chat(u.client, await u.session());
      expect(after.status, JSON.stringify(after.body)).toBe(200);
      await settled(after.body.taskId ?? "");
    }
  });

  it(
    "零余额或额度已满、模型停用时提交 → 执行前重新启用 → 仍按不可用失败,不请求上游、不留无冻结无价目的运行",
    { timeout: 90_000 },
    async () => {
      const setEnabled = async (enabled: boolean) => {
        const r = await admin.post<{ model: typeof modelDef }>("/api/admin/models", {
          expectedVersion: modelDef.version,
          definition: { ...modelDef, enabled },
        });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        modelDef = r.body.model;
      };
      const run = async (runId: string) => {
        const db = await database();
        try {
          const [rows] = await db.execute(
            "SELECT status, pricing, cost, error_info FROM runs WHERE id = ?",
            [runId],
          );
          return (
            rows as { status: string; pricing: unknown; cost: unknown; error_info: unknown }[]
          )[0];
        } finally {
          await db.end();
        }
      };

      const broke = await customer("unavail-broke");
      const capped = await customer("unavail-capped", "1000");
      {
        const r = await admin.patch("/api/admin/accounts", {
          id: capped.accountId,
          monthlyLimitCredits: "0",
        });
        expect(r.status).toBe(200);
      }

      for (const who of [broke, capped]) {
        const before = await who.balance();
        const s = await who.session();
        // 1) 在库里给会话放一条"运行中、租约未过期"的占位运行:认领会跳过有活跃运行的会话,
        //    第二条必然排在后面,直到我们重新启用模型、放开会话 —— 时序确定,不靠网关延迟
        const holderId = `hold${Date.now()}${Math.floor(Math.random() * 1e6)}`.slice(0, 24);
        {
          const db = await database();
          try {
            await db.execute(
              "INSERT INTO runs (id, session_id, status, prompt, lease_until) VALUES (?, ?, 'running', '占位', ?)",
              [holderId, s, Date.now() + 10 * 60_000],
            );
          } finally {
            await db.end();
          }
        }

        // 2) 模型停用:提交
        await setEnabled(false);
        const marker = `不该到达上游-${who.accountId}`;
        let queuedId = "";
        try {
          const queued = await fetch(`${BASE}/api/sessions/${s}/run`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: who.client.cookieHeader() },
            body: JSON.stringify({ prompt: marker }),
          });
          // 不读响应体:SSE 要等运行结束才收尾,而运行此刻被占位运行挡着
          expect(queued.status).toBe(200);
          queuedId = queued.headers.get("X-Run-Id") ?? "";
          void queued.body?.cancel();
          // 受理时就记成"不可执行",而不是没有价目的普通运行
          const pending = await run(queuedId);
          expect(pending?.status).toBe("pending");
          const pinned = (
            typeof pending?.pricing === "string" ? JSON.parse(pending.pricing) : pending?.pricing
          ) as { unavailableAtAdmission?: { code: string } } | null;
          expect(pinned?.unavailableAtAdmission?.code).toBe("model_disabled");
        } finally {
          // 3) 执行前重新启用模型
          await setEnabled(true);
        }

        // 4) 放开会话,等它执行完
        {
          const db = await database();
          try {
            await db.execute(
              "UPDATE runs SET status = 'success', lease_until = NULL, ended_at = NOW() WHERE id = ?",
              [holderId],
            );
          } finally {
            await db.end();
          }
        }
        const c = await settled(queuedId);
        const done = await run(queuedId);
        expect(done?.status).toBe("failed");
        expect(JSON.stringify(done?.error_info)).toContain("model_unavailable");
        expect(done?.cost ?? null).toBeNull();
        // 没有请求上游:网关收到的请求里没有这一条的输入
        expect(JSON.stringify(gw.seenRequests)).not.toContain(marker);
        // 没有冻结、没有扣费
        expect(c).toMatchObject({ mode: "live", charged_micro: "0" });
        expect(String((c as unknown as { reserved_micro: string }).reserved_micro)).toBe("0");
        expect(await who.balance()).toEqual(
          expect.objectContaining({ availableMicroCredits: before.availableMicroCredits }),
        );
      }
    },
  );

  it("对话、分支、调用、AI 设计、评测五个入口都产生计费记录", { timeout: 60_000 }, async () => {
    const u = await customer("entries", "1000");
    const ids: Record<string, string> = {};

    const s = await u.session();
    const first = await chat(u.client, s);
    ids.chat = first.body.taskId ?? "";

    const branch = await u.client.post<{ runId?: string }>(`/api/sessions/${s}/branch`, {
      fromRunId: ids.chat,
      mode: "rewind",
      prompt: "换个说法",
    });
    expect(branch.status, JSON.stringify(branch.body)).toBe(202);
    ids.branch = branch.body.runId ?? "";

    const key = (
      await u.client.post<{ plaintext: string }>("/api/keys", { name: "e", agentId: u.agentId })
    ).body.plaintext;
    const invoked = await new Client("entries-api").post<{ taskId?: string }>(
      `/api/agents/${u.agentId}/invoke`,
      { input: "hi" },
      { "X-Api-Key": key },
    );
    expect(invoked.status).toBe(202);
    ids.invoke = invoked.body.taskId ?? "";

    const design = await u.client.post<{ sessionId: string }>("/api/agents/design", {
      agentId: u.agentId,
    });
    expect(design.status).toBe(201);
    const view = await u.client.get<{ revision: string }>(
      `/api/agents/design/${design.body.sessionId}`,
    );
    const controller = new AbortController();
    const designRun = await fetch(`${BASE}/api/agents/design/${design.body.sessionId}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: u.client.cookieHeader() },
      body: JSON.stringify({ prompt: "加一句问候", revision: view.body.revision }),
      signal: controller.signal,
    });
    expect(designRun.status).toBe(200);
    ids.design = designRun.headers.get("X-Run-Id") ?? "";
    controller.abort();

    await u.client.post(`/api/agents/${u.agentId}/evals/cases`, { name: "一例", input: "你好" });
    const evalRun = await u.client.post<{ run?: { id: string } }>(
      `/api/agents/${u.agentId}/evals/runs`,
      { target: "draft" },
    );
    expect(evalRun.status, JSON.stringify(evalRun.body)).toBe(202);
    const detail = await u.client.get<{ results?: { taskId?: string }[] }>(
      `/api/agents/${u.agentId}/evals/runs/${evalRun.body.run?.id}`,
    );
    ids.eval = detail.body.results?.[0]?.taskId ?? "";

    for (const [entry, runId] of Object.entries(ids)) {
      expect(runId, entry).toBeTruthy();
      const c = await chargeRow(runId);
      expect(c, entry).toMatchObject({ account_id: u.accountId, mode: "live" });
    }
  });
});
