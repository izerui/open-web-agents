import { describe, expect, it, vi } from "vitest";
import { McpConnectionCheck } from "../mcp-connection-check";

const okResult = {
  ok: true as const,
  transport: "streamable_http" as const,
  server: {},
  tools: [],
  latencyMs: 1,
};

function setup(saved: Record<string, string> = {}, allowStdioMcp = false) {
  const probe = vi.fn(async () => okResult);
  const variablesOf = vi.fn(async () => saved);
  return {
    probe,
    variablesOf,
    check: new McpConnectionCheck({ allowStdioMcp, variablesOf, probe }),
  };
}

describe("McpConnectionCheck", () => {
  it("变量值取本人在这个智能体上保存的,替换后去连,密钥交给探测器用于抹除", async () => {
    const s = setup({ TOKEN: "sk-saved-1" });
    const r = await s.check.check({
      def: { name: "m", type: "http", url: "https://a.example/mcp?t={{TOKEN}}" },
      variables: [{ name: "TOKEN", required: true, secret: true }],
      agentId: "a1",
      userId: "u1",
    });
    expect(r).toBe(okResult);
    expect(s.variablesOf).toHaveBeenCalledWith("a1", "u1");
    expect(s.probe).toHaveBeenCalledWith(
      { name: "m", type: "http", url: "https://a.example/mcp?t=sk-saved-1" },
      ["sk-saved-1"],
    );
  });

  it("缺变量值、配置不合法、stdio 未启用:不去连", async () => {
    const s = setup();
    const missing = await s.check.check({
      def: { name: "m", type: "http", url: "https://a.example/{{TOKEN}}" },
      variables: [{ name: "TOKEN", required: true, secret: true }],
      userId: "u1",
    });
    expect(missing).toMatchObject({ ok: false, kind: "missing_variables", missing: ["TOKEN"] });
    expect(missing.ok === false && missing.message).toContain("先保存智能体");
    expect(s.variablesOf).not.toHaveBeenCalled();
    const stdio = await s.check.check({
      def: { name: "s", type: "stdio", command: "x" },
      userId: "u1",
    });
    expect(stdio).toMatchObject({ ok: false, kind: "stdio_disabled" });
    const bad = await s.check.check({ def: { name: "m", type: "http" }, userId: "u1" });
    expect(bad).toMatchObject({ ok: false, kind: "invalid_config" });
    expect(s.probe).not.toHaveBeenCalled();
  });
});
