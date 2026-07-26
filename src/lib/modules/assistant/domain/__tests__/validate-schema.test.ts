// schema 编译与缓存的行为。
//
// 这两条是真踩过的坑,合起来会让助手【每个进程只能正常工作一次】:
// 1. 缓存按对象身份(WeakMap)存,而仓储每次 get() 都从 JSON 列解析出新对象 —— 永不命中
// 2. 全局共享的 Ajv 实例不允许同一个 $id 注册两次,于是第 2 次编译抛
//    "schema with key or id already exists",被上层 catch 成"outputSchema 非法",
//    把库的内部状态问题说成用户的配置写错了
//
// 带 $id 的 schema 从 JSON-Schema 工具链粘过来极其常见,所以这不是边角情况。

import {
  _clearSchemaCache,
  validateAgainstSchema,
} from "@/lib/modules/assistant/domain/validate-schema";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(() => _clearSchemaCache());

const withId = () => ({
  $id: "https://example.test/schemas/report",
  type: "object",
  properties: { score: { type: "number" } },
  required: ["score"],
});

describe("validateAgainstSchema / 【$id 回归】同一 schema 反复编译", () => {
  it("带 $id 的 schema 连续校验多次都正常 —— 不是只能用一次", () => {
    for (let i = 0; i < 5; i++) {
      // 每次都传新对象,模拟仓储从 JSON 列解析出来的情形
      const r = validateAgainstSchema(withId(), { score: i }, "outputSchema");
      expect(r.ok).toBe(true);
    }
  });

  it("两个内容相同但 $id 相同的独立对象互不干扰", () => {
    expect(validateAgainstSchema(withId(), { score: 1 }, "outputSchema").ok).toBe(true);
    expect(validateAgainstSchema(withId(), { score: 2 }, "outputSchema").ok).toBe(true);
  });

  it("不合格的值仍如实报错,不会因为缓存而误判", () => {
    expect(validateAgainstSchema(withId(), { score: 1 }, "outputSchema").ok).toBe(true);
    const bad = validateAgainstSchema(withId(), { score: "x" }, "outputSchema");
    expect(bad.ok).toBe(false);
    expect(bad.errors?.join(" ")).toMatch(/score|number/);
  });
});

describe("validateAgainstSchema / 错误归因", () => {
  it("schema 本身非法时,错误信息带上是哪一侧的契约", () => {
    const r = validateAgainstSchema({ type: "object", properties: 42 }, {}, "inputSchema");
    expect(r.ok).toBe(false);
    expect(r.errors?.[0]).toMatch(/inputSchema 非法/);
  });

  it("值不合格与 schema 非法的措辞可区分", () => {
    const r = validateAgainstSchema({ type: "object", required: ["a"] }, {}, "inputSchema");
    expect(r.ok).toBe(false);
    expect(r.errors?.[0]).not.toMatch(/非法/);
  });

  it("同一份 schema 反复校验不同的值,结果互不污染", () => {
    const s = { type: "object", properties: { n: { type: "number" } }, required: ["n"] };
    expect(validateAgainstSchema(s, { n: 1 }, "x").ok).toBe(true);
    expect(validateAgainstSchema(s, {}, "x").ok).toBe(false);
    expect(validateAgainstSchema(s, { n: 2 }, "x").ok).toBe(true);
  });
});
