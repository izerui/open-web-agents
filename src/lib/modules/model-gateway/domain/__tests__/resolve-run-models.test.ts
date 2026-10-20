import type { Capability } from "@/lib/modules/capabilities/domain/catalog";
import { describe, expect, it } from "vitest";
import type { ModelAliases, Provider } from "../provider";
import { ModelUnavailable, resolvePinnedModels, resolveRunModels } from "../resolve-run-models";

const provider = (id: string, over: Partial<Provider> = {}): Provider => ({
  id,
  name: id,
  enabled: true,
  endpoints: { llm: { protocol: "anthropic", baseUrl: `https://${id}.example` } },
  hasKey: true,
  keyHint: "****",
  version: 1,
  updatedAt: 0,
  ...over,
});

const model = (id: string, providerId: string, over: Partial<Capability> = {}): Capability => ({
  id,
  name: `名-${id}`,
  kind: "llm",
  modelId: `real-${id}`,
  enabled: true,
  acceptsImages: false,
  rates: [],
  providerId,
  version: 3,
  updatedAt: 0,
  ...over,
});

const aliases: ModelAliases = {
  providerId: "a",
  fable: "a-big",
  opus: "a-big",
  sonnet: "a-main",
  haiku: "a-small",
  version: 1,
  updatedAt: 0,
};

const world = () => ({
  providers: [provider("a"), provider("b")],
  models: [model("a-main", "a"), model("a-big", "a"), model("a-small", "a"), model("b-main", "b")],
  aliases,
});

const fails = (fn: () => unknown, code: string, text?: string) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ModelUnavailable);
    expect((err as ModelUnavailable).code).toBe(code);
    if (text) expect((err as Error).message).toContain(text);
    return;
  }
  throw new Error("应当失败");
};

describe("resolveRunModels", () => {
  it("别名经映射落到具体模型;槽位都在本提供者;计价上下文去重", () => {
    const b = resolveRunModels({ ...world(), main: "sonnet" });
    expect(b).toMatchObject({
      providerId: "a",
      baseUrl: "https://a.example",
      main: { ref: "sonnet", capabilityId: "a-main", modelId: "real-a-main", version: 3 },
      slots: {
        fable: "real-a-big",
        opus: "real-a-big",
        sonnet: "real-a-main",
        haiku: "real-a-small",
      },
    });
    expect(b.pricing.models.map((m) => m.capabilityId).sort()).toEqual([
      "a-big",
      "a-main",
      "a-small",
    ]);
  });

  it("直接引用模型 id;别名映射到别的提供者时槽位回落主模型", () => {
    const b = resolveRunModels({ ...world(), main: "b-main" });
    expect(b.providerId).toBe("b");
    expect(b.slots).toEqual({
      fable: "real-b-main",
      opus: "real-b-main",
      sonnet: "real-b-main",
      haiku: "real-b-main",
    });
    expect(b.pricing).toEqual({
      providerId: "b",
      models: [{ capabilityId: "b-main", modelId: "real-b-main", version: 3 }],
      binding: {
        mainRef: "b-main",
        main: "b-main",
        subagents: {},
        slots: { fable: null, opus: null, sonnet: null, haiku: null },
      },
    });
  });

  it("调用方覆盖优先于配置", () => {
    expect(
      resolveRunModels({ ...world(), main: "sonnet", override: "haiku" }).main.capabilityId,
    ).toBe("a-small");
  });

  it("子代理:同提供者解析成功,跨提供者拒绝", () => {
    const b = resolveRunModels({
      ...world(),
      main: "sonnet",
      subagents: [{ name: "cheap", model: "haiku" }, { name: "same" }],
    });
    expect(b.subagents).toEqual({
      cheap: {
        ref: "haiku",
        capabilityId: "a-small",
        modelId: "real-a-small",
        name: "名-a-small",
        version: 3,
      },
    });
    fails(
      () =>
        resolveRunModels({
          ...world(),
          main: "sonnet",
          subagents: [{ name: "x", model: "b-main" }],
        }),
      "cross_provider",
      "子代理「x」",
    );
  });

  it("模型停用、提供者停用都按停用处理,提示不暴露提供者", () => {
    const w = world();
    fails(
      () =>
        resolveRunModels({
          ...w,
          models: w.models.map((m) => (m.id === "a-main" ? { ...m, enabled: false } : m)),
          main: "a-main",
        }),
      "model_disabled",
      "「名-a-main」已停用",
    );
    try {
      resolveRunModels({ ...w, providers: [provider("a", { enabled: false })], main: "a-main" });
    } catch (err) {
      expect((err as ModelUnavailable).code).toBe("model_disabled");
      expect((err as Error).message).not.toContain("提供者");
    }
  });

  it("模型不存在或不是文本模型:作者要换模型;别名缺目标:平台未配置", () => {
    fails(() => resolveRunModels({ ...world(), main: "ghost" }), "model_not_found");
    const w = world();
    fails(
      () =>
        resolveRunModels({
          ...w,
          models: [...w.models, model("img", "a", { kind: "image" })],
          main: "img",
        }),
      "model_not_found",
    );
    fails(() => resolveRunModels({ ...w, aliases: null, main: "sonnet" }), "not_configured");
  });

  it("提供者没有文本接入地址或没有 Key:平台未配置", () => {
    const w = world();
    fails(
      () =>
        resolveRunModels({ ...w, providers: [provider("a", { endpoints: {} })], main: "a-main" }),
      "not_configured",
    );
    fails(
      () =>
        resolveRunModels({ ...w, providers: [provider("a", { hasKey: false })], main: "a-main" }),
      "not_configured",
    );
  });

  it("子代理模型停用或不存在", () => {
    const w = world();
    fails(
      () =>
        resolveRunModels({
          ...w,
          models: w.models.map((m) => (m.id === "a-small" ? { ...m, enabled: false } : m)),
          main: "sonnet",
          subagents: [{ name: "cheap", model: "haiku" }],
        }),
      "model_disabled",
      "子代理「cheap」",
    );
    fails(
      () => resolveRunModels({ ...w, main: "sonnet", subagents: [{ name: "x", model: "ghost" }] }),
      "model_not_found",
    );
  });

  describe("resolvePinnedModels", () => {
    const pin = () => {
      const w = world();
      const b = resolveRunModels({
        ...w,
        main: "sonnet",
        subagents: [{ name: "cheap", model: "haiku" }],
      });
      return { w, pricing: b.pricing as Parameters<typeof resolvePinnedModels>[0]["pricing"] };
    };
    const versionsOf = (models: Capability[]) => new Map(models.map((m) => [m.id, m]));

    it("按锁定绑定与版本解析:之后改别名映射、换模型标识都不影响", async () => {
      const { w, pricing } = pin();
      const changed = w.models.map((m) =>
        m.id === "a-main" ? { ...m, modelId: "renamed", version: 4 } : m,
      );
      const b = resolvePinnedModels({
        pricing,
        models: changed,
        providers: w.providers,
        versions: versionsOf(w.models),
      });
      expect(b.main).toMatchObject({ capabilityId: "a-main", modelId: "real-a-main", version: 3 });
      expect(b.subagents.cheap?.modelId).toBe("real-a-small");
      expect(b.slots.sonnet).toBe("real-a-main");
      expect(b.pricing).toBe(pricing);
    });

    it("排队期间模型或提供者被停用:不跑", () => {
      const { w, pricing } = pin();
      fails(
        () =>
          resolvePinnedModels({
            pricing,
            models: w.models.map((m) => (m.id === "a-main" ? { ...m, enabled: false } : m)),
            providers: w.providers,
            versions: versionsOf(w.models),
          }),
        "model_disabled",
      );
      fails(
        () =>
          resolvePinnedModels({
            pricing,
            models: w.models,
            providers: [provider("a", { enabled: false })],
            versions: versionsOf(w.models),
          }),
        "model_disabled",
      );
    });

    it("别名槽指向的模型停用:退回主模型,不让运行失败", () => {
      const { w, pricing } = pin();
      const b = resolvePinnedModels({
        pricing,
        models: w.models.map((m) => (m.id === "a-big" ? { ...m, enabled: false } : m)),
        providers: w.providers,
        versions: versionsOf(w.models),
      });
      expect(b.slots.opus).toBe("real-a-main");
    });
  });
});
