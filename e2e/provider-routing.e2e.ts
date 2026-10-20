// 运行真的按模型所属提供者路由:假网关验证收到的 Key 与模型标识,运行记录所属提供者与当时价格。
// 需要带 worker 的服务与可写的测试库(OWA_E2E_DATABASE_URL,库名含 test):要把测试账号临时设为管理员。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeGateway } from "../scripts/sdk-probe/fake-gateway.mjs";
import { priceUsage } from "../src/lib/modules/capabilities/domain/catalog";
import type { Capability } from "../src/lib/modules/capabilities/domain/catalog";
import { Client, newUser, serverUp } from "./client";

const databaseUrl = process.env.OWA_E2E_DATABASE_URL;
if (databaseUrl && !/test/i.test(new URL(databaseUrl).pathname)) {
  throw new Error("provider routing E2E requires a dedicated test database");
}

type Gateway = {
  baseUrl: string;
  seenRequests: ({ model?: string } | null)[];
  seenKeys: (string | null)[];
  close: () => void;
};
type RunBody = { taskId?: string; status?: string; error?: { kind?: string; message?: string } };
type PublicModelUsage = {
  model: string | null;
  name: string;
  version: number | null;
  inputTokens: number;
  outputTokens: number;
  microCredits: string | null;
  unpriced: boolean;
};
type PublicCost = {
  input: number;
  output: number;
  creditEstimate?: { totalMicroCredits: string; models: PublicModelUsage[] };
} | null;
type RunDetail = { run: { cost: PublicCost } };
type Metering = {
  models: {
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  }[];
};

describe.skipIf(!databaseUrl)("按提供者路由与计价", () => {
  let owner: Client;
  let promotedId: string | undefined;
  let gw: Gateway;
  let providerId = "";
  let model: Capability;
  let agentId = "";
  const tag = Date.now();
  const key = `sk-e2e-routing-${tag}`;
  const upstreamModel = `e2e-routed-${tag}`;

  async function database() {
    const { createConnection } = await import("mysql2/promise");
    if (!databaseUrl) throw new Error("missing test database");
    return createConnection(databaseUrl);
  }

  /** 库里那份完整的 cost(含计价上下文) */
  async function storedCost(runId: string) {
    const db = await database();
    try {
      const [rows] = await db.execute("SELECT cost FROM runs WHERE id = ?", [runId]);
      const raw = (rows as { cost: unknown }[])[0]?.cost;
      return (typeof raw === "string" ? JSON.parse(raw) : raw) as {
        pricing?: { providerId: string; models: { capabilityId: string }[] };
        metering?: Metering;
      };
    } finally {
      await db.end();
    }
  }

  const run = async () => {
    const s = (await owner.post<{ session?: { id: string } }>("/api/sessions", { agentId })).body
      .session;
    return owner.post<RunBody>(`/api/sessions/${s?.id}/run`, { prompt: "你好", stream: false });
  };

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("server unavailable");
    gw = (await startFakeGateway([])) as Gateway;
    owner = await newUser("routing-admin");
    const me = await owner.get<{ user: { id: string; role: string } }>("/api/auth");
    if (me.body.user.role !== "admin") {
      promotedId = me.body.user.id;
      const db = await database();
      try {
        await db.execute("UPDATE users SET role = 'admin' WHERE id = ?", [promotedId]);
      } finally {
        await db.end();
      }
    }
    const p = await owner.post<{ provider: { id: string } }>("/api/admin/providers", {
      definition: {
        name: `路由测试-${tag}`,
        enabled: true,
        endpoints: { llm: { protocol: "anthropic", baseUrl: gw.baseUrl } },
      },
      apiKey: key,
    });
    expect(p.status).toBe(201);
    providerId = p.body.provider.id;
    const cost = (yuan: string) => String(Math.round(Number(yuan) * 100_000_000));
    const m = await owner.post<{ model: Capability }>("/api/admin/models", {
      expectedVersion: null,
      definition: {
        name: `路由模型-${tag}`,
        kind: "llm",
        modelId: upstreamModel,
        enabled: true,
        acceptsImages: false,
        providerId,
        markupBp: 1000,
        costRates: [
          { meter: "input_token", units: "1000000", microCredits: cost("21") },
          { meter: "output_token", units: "1000000", microCredits: cost("105") },
          { meter: "cache_read_token", units: "1000000", microCredits: cost("2.1") },
          { meter: "cache_write_token", units: "1000000", microCredits: cost("26.25") },
        ],
        rates: [],
      },
    });
    expect(m.status).toBe(201);
    model = m.body.model;
    const a = await owner.post<{ agent?: { id: string } }>("/api/agents", {
      name: `routing-${tag}`,
      config: { systemPrompt: "简短回答", model: model.id, maxTurns: 2 },
    });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    agentId = a.body.agent?.id ?? "";
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

  it("运行用所选模型所属提供者的 Key 与真实模型标识,并按当时售价估算积分", async () => {
    const r = await run();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe("success");
    expect(gw.seenKeys.length).toBeGreaterThan(0);
    expect(new Set(gw.seenKeys)).toEqual(new Set([key]));
    expect(gw.seenRequests.map((q) => q?.model)).toContain(upstreamModel);

    // 计价上下文只在库里:按它结算与对账,接口不返回
    const stored = await storedCost(r.body.taskId ?? "");
    expect(stored.pricing?.providerId).toBe(providerId);
    expect(stored.pricing?.models.map((x) => x.capabilityId)).toContain(model.id);
    // 原始计量(上游标识)只在库里;按它算出应扣积分,与对外的估算对比
    const used = stored.metering?.models.find((x) => x.modelId === upstreamModel);
    expect(used).toBeTruthy();
    const detail = await owner.get<RunDetail>(`/api/runs/${r.body.taskId}`);
    const cost = detail.body.run.cost;
    const expected = priceUsage(model.rates, {
      input_token: String(used?.inputTokens ?? 0),
      output_token: String(used?.outputTokens ?? 0),
      cache_read_token: String(used?.cacheReadTokens ?? 0),
      cache_write_token: String(used?.cacheWriteTokens ?? 0),
    }).microCredits;
    const shown = cost?.creditEstimate?.models.find((x) => x.model === model.id);
    expect(shown).toMatchObject({
      name: model.name,
      version: model.version,
      inputTokens: used?.inputTokens,
      outputTokens: used?.outputTokens,
      microCredits: expected,
      unpriced: false,
    });
    expect(cost?.creditEstimate?.totalMicroCredits).toBe(expected);
    expect(JSON.stringify(detail.body)).not.toContain(upstreamModel);
  });

  it("普通用户拿到的结果(阻塞响应、调用结果轮询、运行详情、用量)不含提供者与上游模型标识", async () => {
    const normal = await newUser("routing-normal");
    const a = await normal.post<{ agent?: { id: string } }>("/api/agents", {
      name: `normal-${tag}`,
      config: { systemPrompt: "简短回答", model: model.id, maxTurns: 2 },
    });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const id = a.body.agent?.id ?? "";
    const leaks = (label: string, body: unknown) => {
      const text = JSON.stringify(body);
      expect(text, label).not.toContain(providerId);
      expect(text, label).not.toContain('"pricing"');
      expect(text, label).not.toContain(upstreamModel);
      expect(text, label).not.toContain('"metering"');
    };
    // 按模型的明细给公开模型 id 与名称
    const shows = (label: string, cost: PublicCost | undefined) => {
      expect(cost?.creditEstimate?.totalMicroCredits, label).toMatch(/^[1-9]\d*$/);
      expect(
        cost?.creditEstimate?.models.find((m) => m.model === model.id),
        label,
      ).toMatchObject({
        name: model.name,
        version: model.version,
        unpriced: false,
      });
    };

    // 阻塞响应
    const s = (await normal.post<{ session?: { id: string } }>("/api/sessions", { agentId: id }))
      .body.session;
    const blocking = await normal.post<RunBody & { cost?: PublicCost }>(
      `/api/sessions/${s?.id}/run`,
      { prompt: "你好", stream: false },
    );
    expect(blocking.body.status).toBe("success");
    // 库里确实写了计价上下文,不是因为没有才看不到
    expect((await storedCost(blocking.body.taskId ?? "")).pricing?.providerId).toBe(providerId);
    leaks("阻塞响应", blocking.body);
    shows("阻塞响应", blocking.body.cost);

    // 运行详情
    const detail = await normal.get<RunDetail>(`/api/runs/${blocking.body.taskId}`);
    expect(detail.status).toBe(200);
    leaks("运行详情", detail.body);
    expect(detail.body.run.cost?.creditEstimate?.totalMicroCredits).toBe(
      blocking.body.cost?.creditEstimate?.totalMicroCredits,
    );

    // API Key 调用 → 轮询结果
    const issued = await normal.post<{ plaintext: string }>("/api/keys", {
      name: "normal",
      agentId: id,
    });
    const api = new Client("routing-normal-api");
    const headers = { "X-Api-Key": issued.body.plaintext };
    const invoked = await api.post<{ taskId?: string }>(
      `/api/agents/${id}/invoke`,
      { input: "hi" },
      headers,
    );
    expect(invoked.status, JSON.stringify(invoked.body)).toBeLessThan(300);
    let result: { done?: boolean; cost?: PublicCost } = {};
    for (let i = 0; i < 40 && !result.done; i++) {
      result = (await api.get<typeof result>(`/api/agents/${invoked.body.taskId}/result`, headers))
        .body;
      if (!result.done) await new Promise((r) => setTimeout(r, 500));
    }
    expect(result.done).toBe(true);
    expect((await storedCost(invoked.body.taskId ?? "")).pricing?.providerId).toBe(providerId);
    leaks("调用结果", result);
    shows("调用结果", result.cost);

    // 用量接口
    const usage = await normal.get<{
      runs?: { runId: string; estimatedCredits: { models: PublicModelUsage[] } }[];
    }>("/api/usage?days=1");
    expect(usage.status).toBe(200);
    leaks("用量", usage.body);
    const row = usage.body.runs?.find((x) => x.runId === blocking.body.taskId);
    expect(row?.estimatedCredits.models.find((m) => m.model === model.id)?.name).toBe(model.name);
  });

  it("停用模型后:能看到影响面;再运行以模型已停用失败、不再请求上游;调用覆盖为它返回 400", async () => {
    const impact = await owner.get<{ agents: number }>(`/api/admin/models/${model.id}/impact`);
    expect(impact.body.agents).toBeGreaterThanOrEqual(1);
    const saved = await owner.post<{ model: Capability }>("/api/admin/models", {
      expectedVersion: model.version,
      definition: { ...model, enabled: false },
    });
    expect(saved.status).toBe(200);

    const before = gw.seenRequests.length;
    const r = await run();
    expect(r.body.status).toBe("failed");
    expect(r.body.error?.kind).toBe("model_unavailable");
    expect(r.body.error?.message).toContain("已停用");
    expect(gw.seenRequests.length).toBe(before);

    // 停用后的模型不能被当作调用覆盖
    await owner.post("/api/agents", {
      id: agentId,
      name: `routing-${tag}`,
      config: { systemPrompt: "简短回答", model: "sonnet" },
    });
    const keyRes = await owner.post<{ plaintext: string }>("/api/keys", {
      name: "routing",
      agentId,
    });
    const invoke = await new Client("routing-api").post(
      `/api/agents/${agentId}/invoke`,
      { input: "hi", override: { model: model.id } },
      { "X-Api-Key": keyRes.body.plaintext },
    );
    expect(invoke.status).toBe(400);
  });
});
