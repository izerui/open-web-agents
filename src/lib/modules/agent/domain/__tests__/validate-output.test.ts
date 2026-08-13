import { validateStructured } from "@/lib/modules/agent/domain/validate-output";
import { describe, expect, it } from "vitest";

const videoSchema = {
  type: "object",
  properties: {
    videoId: { type: "string" },
    durationSec: { type: "number" },
    scenes: { type: "array", items: { type: "string" } },
  },
  required: ["videoId", "durationSec"],
  additionalProperties: false,
};

describe("validateStructured", () => {
  it("合法结果通过", () => {
    expect(
      validateStructured(videoSchema, { videoId: "v1", durationSec: 90, scenes: ["a"] }),
    ).toEqual({ ok: true });
  });

  it("缺必填字段 → 失败并指出字段", () => {
    const r = validateStructured(videoSchema, { videoId: "v1" });
    expect(r.ok).toBe(false);
    expect(r.errors?.join(" ")).toMatch(/durationSec/);
  });

  it("类型不对 → 失败并指出路径", () => {
    const r = validateStructured(videoSchema, { videoId: "v1", durationSec: "90" });
    expect(r.ok).toBe(false);
    expect(r.errors?.join(" ")).toMatch(/durationSec/);
  });

  it("多余字段在 additionalProperties:false 下被拒", () => {
    const r = validateStructured(videoSchema, { videoId: "v", durationSec: 1, extra: true });
    expect(r.ok).toBe(false);
  });

  it("嵌套数组元素类型错 → 失败", () => {
    const r = validateStructured(videoSchema, { videoId: "v", durationSec: 1, scenes: [1] });
    expect(r.ok).toBe(false);
    expect(r.errors?.join(" ")).toMatch(/scenes/);
  });

  it("undefined(未产出结构化结果)→ 失败并明确原因", () => {
    const r = validateStructured(videoSchema, undefined);
    expect(r.ok).toBe(false);
    expect(r.errors?.[0]).toMatch(/未产出/);
  });

  it("null 不满足 object → 失败", () => {
    expect(validateStructured(videoSchema, null).ok).toBe(false);
  });

  it("schema 本身非法 → 明确区分于结果不合格", () => {
    const r = validateStructured({ type: "not-a-real-type" }, { a: 1 });
    expect(r.ok).toBe(false);
    expect(r.errors?.[0]).toMatch(/outputSchema 非法/);
  });

  it("空 schema 放行任何结果(通用智能体)", () => {
    expect(validateStructured({}, { anything: true })).toEqual({ ok: true });
  });

  it("同一 schema 重复校验结果稳定(编译缓存不串味)", () => {
    const good = { videoId: "v", durationSec: 1 };
    expect(validateStructured(videoSchema, good).ok).toBe(true);
    expect(validateStructured(videoSchema, { videoId: "v" }).ok).toBe(false);
    expect(validateStructured(videoSchema, good).ok).toBe(true);
  });
});
