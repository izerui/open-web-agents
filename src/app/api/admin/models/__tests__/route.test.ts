import { InMemoryCapabilityRepo } from "@/lib/modules/capabilities/adapters/in-memory-capability-repo";
import {
  InMemoryModelAliasRepo,
  InMemoryProviderRepo,
} from "@/lib/modules/model-gateway/adapters/in-memory-provider-repo";
import { ModelAdmin } from "@/lib/modules/model-gateway/application/model-admin";
import { beforeEach, describe, expect, it, vi } from "vitest";

const audit = { record: vi.fn(async (_e: unknown) => {}) };
let modelAdmin: ModelAdmin;
let providerId = "";

vi.mock("@/lib/container", () => ({
  getContainer: () => ({
    modelAdmin,
    audit,
    auth: {
      resolveWeb: async () => ({ type: "web", userId: "admin" }),
      assertCanAdministerPlatform: () => {},
      subjectOf: async () => ({ userId: "admin" }),
    },
  }),
}));

import { POST } from "../route";

const post = (body: unknown) =>
  POST(
    new Request("http://local/api/admin/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const rate = (meter: string, microCredits: string) => ({ meter, units: "1000000", microCredits });

describe("POST /api/admin/models 启用时价格须完整", () => {
  beforeEach(async () => {
    audit.record.mockClear();
    modelAdmin = new ModelAdmin({
      ensureModels: async () => {},
      capabilities: new InMemoryCapabilityRepo(),
      providers: new InMemoryProviderRepo(),
      aliases: new InMemoryModelAliasRepo(),
      agentRefs: { list: async () => [] },
      probe: { testAnthropic: async () => ({ ok: true, latencyMs: 0, message: "" }) },
      encrypt: (p) => p,
      decrypt: (s) => s,
      mask: (p) => p,
    });
    providerId = (
      await modelAdmin.createProvider({ definition: { name: "A", enabled: true } }, "admin")
    ).id;
  });

  const definition = (costRates: unknown[]) => ({
    name: "文本模型",
    kind: "llm",
    modelId: "real-model",
    enabled: true,
    acceptsImages: false,
    providerId,
    markupBp: 1000,
    costRates,
    rates: [],
  });

  it("缺输出价:400,说明缺哪一项,不保存也不写审计", async () => {
    const res = await post({
      expectedVersion: null,
      definition: definition([
        rate("input_token", "2100000000"),
        rate("cache_read_token", "0"),
        rate("cache_write_token", "0"),
      ]),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("invalid_request");
    expect(body.error).toContain("输出 / 百万 token");
    expect(await modelAdmin.listModels()).toEqual([]);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("完整价格(不收费的项明确填 0):201,售价由服务端派生", async () => {
    const res = await post({
      expectedVersion: null,
      definition: definition([
        rate("input_token", "2100000000"),
        rate("output_token", "10500000000"),
        rate("cache_read_token", "0"),
        rate("cache_write_token", "0"),
      ]),
    });
    expect(res.status).toBe(201);
    const { model } = (await res.json()) as {
      model: { rates: { meter: string; microCredits: string }[] };
    };
    expect(model.rates.find((r) => r.meter === "output_token")?.microCredits).toBe("11550000000");
    expect(model.rates.find((r) => r.meter === "cache_read_token")?.microCredits).toBe("0");
    expect(audit.record).toHaveBeenCalledTimes(1);
  });
});
