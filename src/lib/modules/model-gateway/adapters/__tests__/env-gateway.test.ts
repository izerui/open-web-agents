import {
  EnvModelGateway,
  OFFICIAL_MODEL_IDS,
} from "@/lib/modules/model-gateway/adapters/env-gateway";
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

  it("什么都没配:各别名用官方模型 id,而不是把别名字面量当 model id 发给网关", () => {
    expect(new EnvModelGateway({ base: "" }).slots()).toEqual(OFFICIAL_MODEL_IDS);
    expect(new EnvModelGateway({}).slots().fable).toBe("claude-fable-5-1");
  });

  it("只配了某个槽:其余槽仍用官方模型 id", () => {
    const slots = new EnvModelGateway({ opus: "my-opus" }).slots();
    expect(slots.opus).toBe("my-opus");
    expect(slots.sonnet).toBe("claude-sonnet-5-5");
  });
});
