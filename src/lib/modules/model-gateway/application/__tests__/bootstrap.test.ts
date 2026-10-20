import { InMemoryCapabilityRepo } from "@/lib/modules/capabilities/adapters/in-memory-capability-repo";
import { priceUsage } from "@/lib/modules/capabilities/domain/catalog";
import { describe, expect, it } from "vitest";
import { OFFICIAL_MODEL_IDS } from "../../adapters/env-gateway";
import {
  InMemoryBootstrapMarker,
  InMemoryModelAliasRepo,
  InMemoryProviderRepo,
} from "../../adapters/in-memory-provider-repo";
import { BOOTSTRAP_KEY, type BootstrapDeps, bootstrapProviders } from "../bootstrap";

function setup(env: Partial<BootstrapDeps["env"]> = {}) {
  const deps: BootstrapDeps = {
    providers: new InMemoryProviderRepo(),
    aliases: new InMemoryModelAliasRepo(),
    capabilities: new InMemoryCapabilityRepo(),
    marker: new InMemoryBootstrapMarker(),
    encrypt: (p) => `enc(${p})`,
    mask: (p) => `****${p.slice(-4)}`,
    env: {
      baseUrl: "https://api.anthropic.com/",
      apiKey: "sk-ant-secret-1234",
      slots: { ...OFFICIAL_MODEL_IDS },
      ...env,
    },
  };
  return deps;
}

describe("从环境变量生成平台默认提供者", () => {
  it("全新安装:建提供者、加密 Key、四个模型(成本 0)、别名映射、完成标记", async () => {
    const deps = setup();
    await bootstrapProviders(deps);
    const provider = await deps.providers.get("platform-default");
    expect(provider).toMatchObject({
      name: "平台默认",
      enabled: true,
      hasKey: true,
      keyHint: "****1234",
      endpoints: { llm: { protocol: "anthropic", baseUrl: "https://api.anthropic.com" } },
    });
    expect(await deps.providers.keyEnc("platform-default")).toBe("enc(sk-ant-secret-1234)");
    const models = await deps.capabilities.list(true);
    expect(models.map((m) => m.modelId).sort()).toEqual(Object.values(OFFICIAL_MODEL_IDS).sort());
    for (const m of models) {
      expect(m).toMatchObject({
        providerId: "platform-default",
        kind: "llm",
        enabled: true,
        markupBp: 0,
      });
      expect(m.rates.every((r) => r.microCredits === "0")).toBe(true);
    }
    expect(models.find((m) => m.modelId === "claude-sonnet-5-5")?.name).toBe("Claude Sonnet 5.5");
    const aliases = await deps.aliases.get();
    expect(aliases?.providerId).toBe("platform-default");
    const byId = new Map(models.map((m) => [m.id, m.modelId]));
    expect(byId.get(aliases?.sonnet ?? "")).toBe("claude-sonnet-5-5");
    expect(byId.get(aliases?.haiku ?? "")).toBe("claude-haiku-4-5-20251001");
    expect(await deps.marker.isDone(BOOTSTRAP_KEY)).toBe(true);
  });

  it("重复执行不产生重复数据,也不改版本", async () => {
    const deps = setup();
    await bootstrapProviders(deps);
    const before = JSON.stringify({
      p: await deps.providers.list(),
      c: await deps.capabilities.list(true),
      a: await deps.aliases.get(),
    });
    await bootstrapProviders(deps);
    const after = JSON.stringify({
      p: await deps.providers.list(),
      c: await deps.capabilities.list(true),
      a: await deps.aliases.get(),
    });
    expect(after).toBe(before);
  });

  it("收编旧价目:同一用量扣费不变;别名复用已有模型", async () => {
    const deps = setup();
    const legacyRates = [
      { meter: "input_token" as const, units: "1000", microCredits: "3333" },
      { meter: "output_token" as const, units: "7", microCredits: "11" },
    ];
    await deps.capabilities.save(
      {
        id: "sonnet-main",
        name: "主力",
        kind: "llm",
        modelId: "claude-sonnet-5-5",
        enabled: true,
        acceptsImages: true,
        rates: legacyRates,
      },
      null,
      "admin",
    );
    const usage = { input_token: "12345", output_token: "678" };
    const charged = priceUsage(legacyRates, usage).microCredits;
    await bootstrapProviders(deps);
    const adopted = await deps.capabilities.get("sonnet-main");
    expect(adopted).toMatchObject({ providerId: "platform-default", markupBp: 0, version: 2 });
    expect(adopted?.costRates).toEqual(legacyRates);
    expect(priceUsage(adopted?.rates ?? [], usage).microCredits).toBe(charged);
    expect((await deps.aliases.get())?.sonnet).toBe("sonnet-main");
    expect(
      (await deps.capabilities.list(true)).filter((c) => c.modelId === "claude-sonnet-5-5"),
    ).toHaveLength(1);
  });

  it("旧数据里同一标识的文本模型重复:只收编启用的那个,其余停用待处理", async () => {
    const deps = setup();
    const def = {
      name: "M",
      kind: "llm" as const,
      modelId: "dup-model",
      acceptsImages: false,
      rates: [{ meter: "input_token" as const, units: "1", microCredits: "1" }],
    };
    await deps.capabilities.save({ ...def, id: "a-disabled", enabled: false }, null, "admin");
    await deps.capabilities.save({ ...def, id: "b-enabled", enabled: true }, null, "admin");
    await deps.capabilities.save({ ...def, id: "c-enabled", enabled: true }, null, "admin");
    const warnings: string[] = [];
    await bootstrapProviders({ ...deps, warn: (m) => warnings.push(m) });
    const all = await deps.capabilities.list(true);
    const adopted = all.filter((c) => c.modelId === "dup-model" && c.providerId);
    expect(adopted.map((c) => c.id)).toEqual(["b-enabled"]);
    expect(all.find((c) => c.id === "c-enabled")?.enabled).toBe(false);
    expect(warnings).toHaveLength(2);
  });

  it("只配了一个模型时,四个别名都指向它", async () => {
    const one = "vendor-model";
    const deps = setup({ slots: { fable: one, opus: one, sonnet: one, haiku: one } });
    await bootstrapProviders(deps);
    const models = await deps.capabilities.list(true);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ id: "default-vendor-model", name: "vendor-model" });
    const a = await deps.aliases.get();
    expect([a?.fable, a?.opus, a?.sonnet, a?.haiku]).toEqual(Array(4).fill("default-vendor-model"));
  });

  it("先启动、后补 Key:完成标记之后仍会补写一次,已有 Key 不覆盖", async () => {
    const deps = setup({ apiKey: "" });
    await bootstrapProviders(deps);
    expect((await deps.providers.get("platform-default"))?.hasKey).toBe(false);
    await bootstrapProviders({ ...deps, env: { ...deps.env, apiKey: "sk-later-9999" } });
    expect((await deps.providers.get("platform-default"))?.keyHint).toBe("****9999");
    await bootstrapProviders({ ...deps, env: { ...deps.env, apiKey: "sk-other-0000" } });
    expect(await deps.providers.keyEnc("platform-default")).toBe("enc(sk-later-9999)");
  });

  it("中途失败不写完成标记,下次启动会补做", async () => {
    const deps = setup();
    const saveAliases = deps.aliases.save.bind(deps.aliases);
    let fail = true;
    deps.aliases.save = async (...args) => {
      if (fail) throw new Error("数据库暂时不可用");
      return saveAliases(...args);
    };
    await expect(bootstrapProviders(deps)).rejects.toThrow(/暂时不可用/);
    expect(await deps.marker.isDone(BOOTSTRAP_KEY)).toBe(false);
    fail = false;
    await bootstrapProviders(deps);
    expect(await deps.aliases.get()).toBeTruthy();
    expect(await deps.capabilities.list(true)).toHaveLength(4);
  });

  it("并发启动只生效一次", async () => {
    const deps = setup();
    await Promise.all([
      bootstrapProviders(deps),
      bootstrapProviders(deps),
      bootstrapProviders(deps),
    ]);
    expect(await deps.providers.list()).toHaveLength(1);
    expect(await deps.capabilities.list(true)).toHaveLength(4);
    expect((await deps.aliases.get())?.version).toBe(1);
  });

  it("旧版用保留字作模型 ID(sonnet 等):换成 legacy- 新 ID 收编,扣费不变,旧记录停用并保留历史", async () => {
    const legacyRates = [
      { meter: "input_token" as const, units: "1000", microCredits: "3333" },
      { meter: "output_token" as const, units: "7", microCredits: "11" },
    ];
    const old = (id: string, modelId: string, enabled = true) => ({
      id,
      name: `旧-${id}`,
      kind: "llm" as const,
      modelId,
      enabled,
      acceptsImages: true,
      rates: legacyRates,
      version: 1,
      updatedAt: 0,
    });
    const deps = {
      ...setup(),
      capabilities: new InMemoryCapabilityRepo([
        old("sonnet", "claude-sonnet-5-5"),
        old("haiku", "claude-haiku-4-5-20251001", false),
        // 与 sonnet 同一模型标识:只能有一条收编的,另一条指向它
        old("opus", "claude-sonnet-5-5"),
      ]),
    };
    await bootstrapProviders(deps);
    await bootstrapProviders(deps);

    const all = await deps.capabilities.list(true);
    const legacySonnet = all.find((c) => c.id === "legacy-sonnet");
    expect(legacySonnet).toMatchObject({
      providerId: "platform-default",
      modelId: "claude-sonnet-5-5",
      enabled: true,
      markupBp: 0,
      version: 1,
    });
    const usage = { input_token: "12345", output_token: "678" };
    expect(priceUsage(legacySonnet?.rates ?? [], usage).microCredits).toBe(
      priceUsage(legacyRates, usage).microCredits,
    );
    expect(all.find((c) => c.id === "legacy-haiku")).toMatchObject({ enabled: false });

    for (const [oldId, target] of [
      ["sonnet", "legacy-sonnet"],
      ["haiku", "legacy-haiku"],
      ["opus", "legacy-sonnet"],
    ] as const) {
      const retired = await deps.capabilities.get(oldId);
      expect(retired).toMatchObject({ enabled: false, replacedBy: target, version: 2 });
      expect((await deps.capabilities.version(oldId, 1))?.rates).toEqual(legacyRates);
    }
    expect((await deps.aliases.get())?.sonnet).toBe("legacy-sonnet");
    expect(
      all.filter((c) => c.providerId === "platform-default" && c.modelId === "claude-sonnet-5-5"),
    ).toHaveLength(1);
    expect(await deps.marker.isDone(BOOTSTRAP_KEY)).toBe(true);
  });

  it("保留字旧记录:新建后、停用前中断,重新启动复用已建好的那条", async () => {
    const deps = {
      ...setup(),
      capabilities: new InMemoryCapabilityRepo([
        {
          id: "sonnet",
          name: "旧",
          kind: "llm",
          modelId: "claude-sonnet-5-5",
          enabled: true,
          acceptsImages: false,
          rates: [{ meter: "input_token", units: "1", microCredits: "1" }],
          version: 1,
          updatedAt: 0,
        },
      ]),
    };
    const retire = deps.capabilities.retire.bind(deps.capabilities);
    let crash = true;
    deps.capabilities.retire = async (...args) => {
      if (crash) throw new Error("进程被杀");
      return retire(...args);
    };
    await expect(bootstrapProviders(deps)).rejects.toThrow(/进程被杀/);
    crash = false;
    await bootstrapProviders(deps);
    const all = await deps.capabilities.list(true);
    expect(all.map((c) => c.id).sort()).toEqual(
      [
        "default-claude-fable-5-1",
        "default-claude-haiku-4-5-20251001",
        "default-claude-opus-5-5",
        "legacy-sonnet",
        "sonnet",
      ].sort(),
    );
    expect((await deps.capabilities.get("sonnet"))?.replacedBy).toBe("legacy-sonnet");
  });
});
