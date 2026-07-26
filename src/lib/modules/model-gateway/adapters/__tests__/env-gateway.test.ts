import { EnvModelGateway } from "@/lib/modules/model-gateway/adapters/env-gateway";
import { describe, expect, it } from "vitest";

describe("EnvModelGateway", () => {
  it("未单独配置的槽全部回退到 base(单模型部署)", () => {
    expect(new EnvModelGateway({ base: "qwen3.7-plus" }).slots()).toEqual({
      fable: "qwen3.7-plus",
      opus: "qwen3.7-plus",
      sonnet: "qwen3.7-plus",
      haiku: "qwen3.7-plus",
    });
  });

  it("单独配置的槽优先", () => {
    const slots = new EnvModelGateway({
      base: "base-m",
      opus: "strong-m",
      haiku: "cheap-m",
    }).slots();
    expect(slots.opus).toBe("strong-m");
    expect(slots.haiku).toBe("cheap-m");
    expect(slots.sonnet).toBe("base-m");
  });

  it("空串视为未配置,回退 base", () => {
    expect(new EnvModelGateway({ base: "b", opus: "" }).slots().opus).toBe("b");
  });
});
