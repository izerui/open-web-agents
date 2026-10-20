import { InMemoryCapabilityRepo } from "@/lib/modules/capabilities/adapters/in-memory-capability-repo";
import { describe, expect, it, vi } from "vitest";
import {
  InMemoryModelAliasRepo,
  InMemoryProviderRepo,
} from "../../adapters/in-memory-provider-repo";
import type { ProviderRepo } from "../../ports";
import { ModelAdmin, ModelAdminError } from "../model-admin";

function setup(refs: { agentId: string; refs: string[] }[] = []) {
  const probe = {
    testAnthropic: vi.fn(async () => ({
      ok: true,
      status: 200,
      latencyMs: 5,
      message: "连接成功",
    })),
  };
  const providers: ProviderRepo = new InMemoryProviderRepo();
  const capabilities = new InMemoryCapabilityRepo();
  const aliases = new InMemoryModelAliasRepo();
  const admin = new ModelAdmin({
    ensureModels: async () => {},
    capabilities,
    providers,
    aliases,
    agentRefs: { list: async () => refs },
    probe,
    encrypt: (p) => `enc:${p}`,
    decrypt: (s) => (s.startsWith("enc:") ? s.slice(4) : null),
    mask: (p) => `****${p.slice(-4)}`,
  });
  return { admin, probe, providers, capabilities, aliases };
}

const llmEndpoint = { llm: { protocol: "anthropic", baseUrl: "https://gw.example/" } };
const cost = [
  { meter: "input_token", units: "1000000", microCredits: "2100000000" },
  { meter: "output_token", units: "1000000", microCredits: "10500000000" },
  { meter: "cache_read_token", units: "1000000", microCredits: "0" },
  { meter: "cache_write_token", units: "1000000", microCredits: "0" },
];

async function rejects(p: Promise<unknown>, status: number, text?: RegExp) {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(ModelAdminError);
  expect((err as ModelAdminError).status).toBe(status);
  if (text) expect((err as Error).message).toMatch(text);
}

describe("ModelAdmin", () => {
  it("新建提供者:自动生成 ID、Key 只以掩码出现", async () => {
    const { admin, providers } = setup();
    const p = await admin.createProvider(
      {
        definition: { name: "厂商 A", enabled: true, endpoints: llmEndpoint },
        apiKey: "sk-secret-9876",
      },
      "admin",
    );
    expect(p.id).toMatch(/^p-[0-9a-f]{8}$/);
    expect(p).toMatchObject({ hasKey: true, keyHint: "****9876" });
    expect(JSON.stringify(p)).not.toContain("sk-secret");
    expect(JSON.stringify(await admin.overview())).not.toContain("sk-secret");
    expect(await providers.keyEnc(p.id)).toBe("enc:sk-secret-9876");
  });

  it("输入不合法 400、名称重复 409、版本冲突 409、不存在 404", async () => {
    const { admin } = setup();
    await rejects(admin.createProvider({ definition: { name: "", enabled: true } }, "a"), 400);
    await rejects(
      admin.createProvider({ definition: { name: "A", enabled: true }, apiKey: "has space" }, "a"),
      400,
      /API Key/,
    );
    const p = await admin.createProvider({ definition: { name: "A", enabled: true } }, "a");
    await rejects(admin.createProvider({ definition: { name: "A", enabled: true } }, "a"), 409);
    await admin.updateProvider(
      p.id,
      { definition: { name: "A2", enabled: true }, expectedVersion: 1 },
      "a",
    );
    await rejects(
      admin.updateProvider(
        p.id,
        { definition: { name: "A3", enabled: true }, expectedVersion: 1 },
        "a",
      ),
      409,
    );
    await rejects(admin.replaceKey("missing", "sk-x", "a"), 404);
  });

  it("测试连接:默认用已保存的地址与 Key;表单里的值优先;Key 解不开不发请求", async () => {
    const { admin, probe, providers } = setup();
    const p = await admin.createProvider(
      { definition: { name: "A", enabled: true, endpoints: llmEndpoint }, apiKey: "sk-saved" },
      "a",
    );
    await admin.testConnection(p.id, { modelId: "m-1" });
    expect(probe.testAnthropic).toHaveBeenLastCalledWith({
      baseUrl: "https://gw.example",
      key: "sk-saved",
      modelId: "m-1",
    });
    await admin.testConnection(p.id, {
      modelId: "m-1",
      baseUrl: "https://other.example",
      apiKey: "sk-form",
    });
    expect(probe.testAnthropic).toHaveBeenLastCalledWith({
      baseUrl: "https://other.example",
      key: "sk-form",
      modelId: "m-1",
    });
    await providers.setKey(p.id, "garbage", "****", "a");
    probe.testAnthropic.mockClear();
    await rejects(admin.testConnection(p.id, { modelId: "m-1" }), 400, /无法解密/);
    expect(probe.testAnthropic).not.toHaveBeenCalled();
  });

  it("保存模型:须挂在已存在的提供者下、按成本价录入;不能移到其他提供者", async () => {
    const { admin } = setup();
    const a = await admin.createProvider({ definition: { name: "A", enabled: true } }, "a");
    const b = await admin.createProvider({ definition: { name: "B", enabled: true } }, "a");
    const base = { name: "M", kind: "llm", modelId: "real", enabled: true, acceptsImages: false };
    await rejects(
      admin.saveModel(
        { definition: { ...base, providerId: "nope", costRates: cost, markupBp: 0 } },
        "a",
      ),
      404,
    );
    await rejects(
      admin.saveModel({ definition: { ...base, providerId: a.id, rates: cost } }, "a"),
      400,
      /成本价/,
    );
    const m = await admin.saveModel(
      { definition: { ...base, providerId: a.id, costRates: cost, markupBp: 1000 } },
      "a",
    );
    expect(m.id).toMatch(/^m-/);
    expect(m.rates[0]?.microCredits).toBe("2310000000");
    await rejects(
      admin.saveModel({ definition: { ...m, providerId: b.id }, expectedVersion: 1 }, "a"),
      400,
      /不能移到其他提供者/,
    );
    await rejects(
      admin.saveModel(
        { definition: { ...base, providerId: a.id, costRates: cost, markupBp: 0 } },
        "a",
      ),
      409,
    );
    expect((await admin.listModels())[0]?.providerName).toBe("A");
  });

  it("别名映射:四个目标须是同一提供者下已启用的文本模型", async () => {
    const { admin } = setup();
    const a = await admin.createProvider({ definition: { name: "A", enabled: true } }, "a");
    const b = await admin.createProvider({ definition: { name: "B", enabled: true } }, "a");
    const mk = async (providerId: string, modelId: string, over = {}) =>
      (
        await admin.saveModel(
          {
            definition: {
              name: modelId,
              kind: "llm",
              modelId,
              enabled: true,
              acceptsImages: false,
              providerId,
              costRates: cost,
              markupBp: 0,
              ...over,
            },
          },
          "a",
        )
      ).id;
    const a1 = await mk(a.id, "a1");
    const aOff = await mk(a.id, "a-off", { enabled: false });
    const b1 = await mk(b.id, "b1");
    const map = {
      providerId: a.id,
      fable: a1,
      opus: a1,
      sonnet: a1,
      haiku: a1,
      expectedVersion: null,
    };
    await rejects(admin.saveAliases({ ...map, haiku: b1 }, "a"), 400, /haiku/);
    await rejects(admin.saveAliases({ ...map, haiku: aOff }, "a"), 400, /haiku/);
    expect((await admin.saveAliases(map, "a")).version).toBe(1);
  });

  it("影响面:直接引用与经别名引用都计入;提供者维度按模型归属统计", async () => {
    const refs: { agentId: string; refs: string[] }[] = [];
    const { admin } = setup(refs);
    const a = await admin.createProvider({ definition: { name: "A", enabled: true } }, "a");
    const mk = async (modelId: string) =>
      admin.saveModel(
        {
          definition: {
            name: modelId,
            kind: "llm",
            modelId,
            enabled: true,
            acceptsImages: false,
            providerId: a.id,
            costRates: cost,
            markupBp: 0,
          },
        },
        "a",
      );
    const main = await mk("main");
    const other = await mk("other");
    await admin.saveAliases(
      {
        providerId: a.id,
        fable: main.id,
        opus: main.id,
        sonnet: main.id,
        haiku: other.id,
        expectedVersion: null,
      },
      "a",
    );
    refs.push(
      { agentId: "by-alias", refs: ["sonnet"] },
      { agentId: "direct", refs: [main.id] },
      { agentId: "subagent", refs: ["haiku", main.id] },
      { agentId: "unrelated", refs: ["haiku"] },
    );
    const impact = await admin.impact({ capabilityId: main.id });
    expect(impact.aliases).toEqual(["fable", "opus", "sonnet"]);
    expect(impact.agents).toBe(3);
    expect((await admin.impact({ capabilityId: other.id })).agents).toBe(2);
    expect((await admin.impact({ providerId: a.id })).agents).toBe(4);
    await rejects(admin.impact({ capabilityId: "ghost" }), 404);
  });

  it("启用模型须填全该类型的价格:缺项 400,明确填 0 可以,停用的草稿可以暂缺", async () => {
    const { admin } = setup();
    const a = await admin.createProvider({ definition: { name: "A", enabled: true } }, "a");
    const base = {
      name: "M",
      kind: "llm",
      modelId: "real",
      acceptsImages: false,
      providerId: a.id,
      markupBp: 0,
    };
    const inputOnly = [cost[0]];
    await rejects(
      admin.saveModel({ definition: { ...base, enabled: true, costRates: inputOnly } }, "a"),
      400,
      /缺少:输出 \/ 百万 token、缓存读取 \/ 百万 token、缓存写入 \/ 百万 token/,
    );
    const draft = await admin.saveModel(
      { definition: { ...base, enabled: false, costRates: inputOnly } },
      "a",
    );
    expect(draft.enabled).toBe(false);
    await rejects(
      admin.saveModel(
        { definition: { ...draft, enabled: true, costRates: inputOnly }, expectedVersion: 1 },
        "a",
      ),
      400,
    );
    const ok = await admin.saveModel(
      { definition: { ...draft, enabled: true, costRates: cost }, expectedVersion: 1 },
      "a",
    );
    expect(ok.enabled).toBe(true);
    const image = await admin.saveModel(
      {
        definition: {
          ...base,
          kind: "image",
          modelId: "img",
          enabled: true,
          costRates: [{ meter: "image", units: "1", microCredits: "0" }],
        },
      },
      "a",
    );
    expect(image.rates[0]?.microCredits).toBe("0");
  });
});
