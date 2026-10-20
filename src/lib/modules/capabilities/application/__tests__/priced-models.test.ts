import { estimateRunCredits } from "@/lib/modules/usage/domain/estimate";
import { describe, expect, it } from "vitest";
import { InMemoryCapabilityRepo } from "../../adapters/in-memory-capability-repo";
import { PricedModels } from "../priced-models";

const llm = (id: string, providerId: string, inputMicroPerMillion: string) => ({
  id,
  name: id,
  kind: "llm" as const,
  modelId: "same-model",
  enabled: true,
  acceptsImages: false,
  providerId,
  markupBp: 0,
  costRates: [
    { meter: "input_token" as const, units: "1000000", microCredits: inputMicroPerMillion },
  ],
  rates: [],
});

const metering = {
  source: "sdk_model_usage" as const,
  complete: true,
  models: [
    {
      modelId: "same-model",
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  ],
};

describe("按运行当时的提供者与价目版本估算积分", () => {
  it("同一模型标识挂在两个提供者下:全局目录无法定价,按运行的计价上下文可以", async () => {
    const repo = new InMemoryCapabilityRepo();
    await repo.save(llm("a-model", "a", "100"), null, "admin");
    await repo.save(llm("b-model", "b", "200"), null, "admin");
    expect(estimateRunCredits(metering, await repo.list()).models[0]?.unpriced).toBe(true);

    const priced = await new PricedModels(repo).forRun({
      providerId: "b",
      models: [{ capabilityId: "b-model", modelId: "same-model", version: 1 }],
    });
    const est = estimateRunCredits(metering, priced ?? []);
    expect(est.totalMicroCredits).toBe("200");
    expect(est.models[0]?.unpriced).toBe(false);
  });

  it("运行之后调价,仍按运行当时的版本估算", async () => {
    const repo = new InMemoryCapabilityRepo();
    await repo.save(llm("a-model", "a", "100"), null, "admin");
    await repo.save(llm("a-model", "a", "999"), 1, "admin");
    const priced = await new PricedModels(repo).forRun({
      providerId: "a",
      models: [{ capabilityId: "a-model", modelId: "same-model", version: 1 }],
    });
    expect(estimateRunCredits(metering, priced ?? []).totalMicroCredits).toBe("100");
  });

  it("旧运行没有计价上下文:返回 null,由调用方回落到当前价目", async () => {
    const priced = new PricedModels(new InMemoryCapabilityRepo());
    expect(await priced.forRun(undefined)).toBeNull();
    expect(await priced.forRun({ providerId: "a", models: [] })).toBeNull();
  });
});
