import { buildSnippets, sampleFromSchema } from "@/features/integration/snippets";
import { describe, expect, it } from "vitest";

describe("sampleFromSchema", () => {
  it("优先 example / examples / default / enum,再按类型兜底", () => {
    expect(sampleFromSchema({ type: "string", example: "x" })).toBe("x");
    expect(sampleFromSchema({ type: "string", examples: ["y"] })).toBe("y");
    expect(sampleFromSchema({ type: "integer", default: 3 })).toBe(3);
    expect(sampleFromSchema({ enum: ["a", "b"] })).toBe("a");
    expect(
      sampleFromSchema({
        type: "object",
        properties: { n: { type: "number" }, tags: { type: "array", items: { type: "boolean" } } },
      }),
    ).toEqual({ n: 0, tags: [false] });
  });
});

describe("buildSnippets", () => {
  const s = buildSnippets({
    origin: "https://owa.example.com",
    agentId: "a1",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", example: "it's 基本不等式" },
        ok: { type: "boolean" },
      },
    },
    hasOutputSchema: true,
  });

  it("curl:绝对地址、带 Key 与幂等键、单引号正确转义", () => {
    expect(s.curl).toContain("https://owa.example.com/api/agents/a1/invoke");
    expect(s.curl).toContain("X-Api-Key: $OWA_API_KEY");
    expect(s.curl).toContain("Idempotency-Key");
    expect(s.curl).toContain(`it'\\''s`);
    expect(s.curl).toContain('"structured"');
  });

  it("Python:JSON 布尔值换成 Python 字面量", () => {
    expect(s.python).toContain('"ok": False');
    expect(s.python).not.toContain("false");
    expect(s.python).toContain('print(res["structured"])');
  });

  it("Node 与嵌入片段指向同一个智能体", () => {
    expect(s.node).toContain("/api/agents/a1/invoke");
    expect(s.embed).toContain('agentId: "a1"');
    expect(s.embed).toContain("https://owa.example.com/api/embed/script");
  });

  it("没有输出契约时取 text", () => {
    const t = buildSnippets({ origin: "http://x", agentId: "b", hasOutputSchema: false });
    expect(t.curl).toContain('"text"');
    expect(t.python).toContain('"input": "你的输入"');
  });
});
