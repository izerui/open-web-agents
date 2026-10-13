import { buildAgentOpenApi } from "@/lib/modules/integration/domain/openapi";
import { describe, expect, it } from "vitest";

/** 按路径取嵌套值,免得测试里到处写 any。 */
const at = (o: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((x, k) => (x as Record<string, unknown> | undefined)?.[k], o);

const invokeBody = (doc: unknown, id: string) =>
  at(
    doc,
    "paths",
    `/api/agents/${id}/invoke`,
    "post",
    "requestBody",
    "content",
    "application/json",
    "schema",
  );

describe("buildAgentOpenApi", () => {
  const schemaIn = {
    type: "object",
    properties: { contract: { type: "string" } },
    required: ["contract"],
  };
  const schemaOut = { type: "object", properties: { verdict: { type: "string" } } };

  it("把智能体的入参与结果契约嵌进文档", () => {
    const doc = buildAgentOpenApi(
      { id: "a1", name: "合同审查", inputSchema: schemaIn, outputSchema: schemaOut },
      "https://owa.example.com",
    );
    expect(doc.openapi).toBe("3.1.0");
    expect(at(doc, "servers", "0", "url")).toBe("https://owa.example.com");
    expect(at(invokeBody(doc, "a1"), "properties", "input", "properties", "contract")).toEqual({
      type: "string",
    });
    const result = at(
      doc,
      "paths",
      "/api/agents/{taskId}/result",
      "get",
      "responses",
      "200",
      "content",
      "application/json",
      "schema",
    );
    expect(at(result, "properties", "structured", "properties", "verdict")).toEqual({
      type: "string",
    });
    expect(at(doc, "components", "securitySchemes", "ApiKey", "name")).toBe("X-Api-Key");
  });

  it("没有契约的智能体:input 是文本", () => {
    const doc = buildAgentOpenApi({ id: "a2", name: "通用" }, "http://x");
    expect(at(invokeBody(doc, "a2"), "properties", "input", "type")).toBe("string");
  });
});
