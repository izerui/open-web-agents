import { extractJsonObject } from "@/lib/modules/agent-engine/domain/extract-json";
import { describe, expect, it } from "vitest";

describe("extractJsonObject", () => {
  it("纯 JSON 直接解析", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it("从 markdown 代码块里提取", () => {
    const text = '好的,结果如下:\n```json\n{"verdict":"pass","score":90}\n```\n以上。';
    expect(extractJsonObject(text)).toEqual({ verdict: "pass", score: 90 });
  });

  it("前后带解释文字也能提取", () => {
    expect(extractJsonObject('分析完毕。{"ok":true} 请查收。')).toEqual({ ok: true });
  });

  it("嵌套对象与数组完整保留", () => {
    const v = extractJsonObject('结果:{"a":{"b":[1,2,{"c":3}]}}');
    expect(v).toEqual({ a: { b: [1, 2, { c: 3 }] } });
  });

  it("字符串里的花括号不打乱配平", () => {
    expect(extractJsonObject('{"tpl":"}{","n":1}')).toEqual({ tpl: "}{", n: 1 });
  });

  it("字符串里的转义引号不打乱配平", () => {
    expect(extractJsonObject('{"q":"say \\"hi\\"","n":2}')).toEqual({ q: 'say "hi"', n: 2 });
  });

  it("取第一个完整对象,不吞掉后面的内容", () => {
    expect(extractJsonObject('{"first":1} 然后 {"second":2}')).toEqual({ first: 1 });
  });

  it("前面有不合法的 { 时,跳过并试下一个", () => {
    expect(extractJsonObject('{ 这不是 json } 但这是 {"real":1}')).toEqual({ real: 1 });
  });

  it("没有 JSON 时返回 undefined", () => {
    expect(extractJsonObject("完全没有结构化内容")).toBeUndefined();
    expect(extractJsonObject("")).toBeUndefined();
  });

  it("未闭合的对象返回 undefined,不抛错", () => {
    expect(extractJsonObject('{"a":1')).toBeUndefined();
  });

  it("顶层数组不提取(契约要求对象)", () => {
    expect(extractJsonObject("[1,2,3]")).toBeUndefined();
  });
});
