import { InMemoryCapabilityRepo } from "@/lib/modules/capabilities/adapters/in-memory-capability-repo";
import {
  InMemoryModelAliasRepo,
  InMemoryProviderRepo,
} from "@/lib/modules/model-gateway/adapters/in-memory-provider-repo";
import type { ModelAliasRepo, ProviderRepo } from "@/lib/modules/model-gateway/ports";
import { beforeEach, describe, expect, it, vi } from "vitest";

let capabilities = new InMemoryCapabilityRepo();
let providers: ProviderRepo = new InMemoryProviderRepo();
let modelAliases: ModelAliasRepo = new InMemoryModelAliasRepo();
vi.mock("@/lib/container", () => ({
  getContainer: () => ({
    capabilities,
    providers,
    modelAliases,
    ensureModels: async () => {},
    auth: { resolveWeb: async () => ({ type: "web", userId: "user" }) },
  }),
}));
import { GET } from "../route";

const llm = (id: string, providerId: string, over = {}) => ({
  id,
  name: `显示名-${id}`,
  kind: "llm" as const,
  modelId: `upstream-${id}`,
  enabled: true,
  acceptsImages: false,
  providerId,
  markupBp: 1000,
  costRates: [{ meter: "input_token" as const, units: "1000000", microCredits: "2100000000" }],
  rates: [],
  ...over,
});

async function view() {
  const res = await GET(new Request("http://local/api/capabilities"));
  expect(res.status).toBe(200);
  const text = await res.text();
  return { text, body: JSON.parse(text) };
}

describe("用户可见的模型价目", () => {
  beforeEach(async () => {
    capabilities = new InMemoryCapabilityRepo();
    providers = new InMemoryProviderRepo();
    modelAliases = new InMemoryModelAliasRepo();
    await providers.save(
      {
        id: "secret-vendor",
        name: "秘密厂商",
        enabled: true,
        endpoints: { llm: { protocol: "anthropic", baseUrl: "https://private-gateway.example" } },
      },
      null,
      "admin",
    );
    await providers.setKey("secret-vendor", "cipher-text", "****abcd", "admin");
  });

  it("只给售价与不透明分组,不暴露提供者、上游模型标识与凭证", async () => {
    await capabilities.save(llm("main", "secret-vendor"), null, "admin");
    const { text, body } = await view();
    const m = body.capabilities[0];
    expect(m).toMatchObject({ id: "main", name: "显示名-main", available: true });
    expect(m.rates[0].microCredits).toBe("2310000000");
    expect(m.group).toMatch(/^[0-9a-f]{12}$/);
    for (const hidden of [
      "secret-vendor",
      "秘密厂商",
      "upstream-main",
      "private-gateway",
      "cipher",
      "abcd",
      "costRates",
      "markupBp",
    ]) {
      expect(text).not.toContain(hidden);
    }
  });

  it("同一来源的模型分组相同,不同来源不同", async () => {
    await providers.save(
      { id: "other", name: "其他", enabled: true, endpoints: {} },
      null,
      "admin",
    );
    await capabilities.save(llm("a", "secret-vendor"), null, "admin");
    await capabilities.save(llm("b", "secret-vendor", { modelId: "x2" }), null, "admin");
    await capabilities.save(llm("c", "other"), null, "admin");
    const groups = Object.fromEntries(
      (await view()).body.capabilities.map((m: { id: string; group: string }) => [m.id, m.group]),
    );
    expect(groups.a).toBe(groups.b);
    expect(groups.a).not.toBe(groups.c);
  });

  it("可用性按实际状态:提供者停用、缺 Key、缺文本接入、媒体模型都不可用", async () => {
    await providers.save(
      {
        id: "nokey",
        name: "无 Key",
        enabled: true,
        endpoints: { llm: { protocol: "anthropic", baseUrl: "https://x.example" } },
      },
      null,
      "admin",
    );
    await providers.save(
      { id: "noep", name: "无接入", enabled: true, endpoints: {} },
      null,
      "admin",
    );
    await providers.setKey("noep", "c", "****", "admin");
    await capabilities.save(llm("k", "nokey"), null, "admin");
    await capabilities.save(llm("e", "noep"), null, "admin");
    await capabilities.save(
      llm("img", "secret-vendor", {
        kind: "image",
        costRates: [{ meter: "image", units: "1", microCredits: "1" }],
      }),
      null,
      "admin",
    );
    const available = Object.fromEntries(
      (await view()).body.capabilities.map((m: { id: string; available: boolean }) => [
        m.id,
        m.available,
      ]),
    );
    expect(available).toEqual({ k: false, e: false, img: false });

    await capabilities.save(llm("main", "secret-vendor"), null, "admin");
    await providers.save(
      {
        id: "secret-vendor",
        name: "秘密厂商",
        enabled: false,
        endpoints: { llm: { protocol: "anthropic", baseUrl: "https://private-gateway.example" } },
      },
      1,
      "admin",
    );
    const after = (await view()).body.capabilities.find((m: { id: string }) => m.id === "main");
    expect(after.available).toBe(false);
  });

  it("返回别名当前指向的模型;停用的模型不出现在列表里", async () => {
    await capabilities.save(llm("main", "secret-vendor"), null, "admin");
    await capabilities.save(
      llm("off", "secret-vendor", { modelId: "o", enabled: false }),
      null,
      "admin",
    );
    await modelAliases.save(
      { providerId: "secret-vendor", fable: "main", opus: "main", sonnet: "main", haiku: "main" },
      null,
      "admin",
    );
    const { body } = await view();
    expect(body.aliases).toEqual({ fable: "main", opus: "main", sonnet: "main", haiku: "main" });
    expect(body.capabilities.map((m: { id: string }) => m.id)).toEqual(["main"]);
  });
});
