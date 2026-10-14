// 只读者看到的智能体配置:能看出用了哪些 MCP、连到哪个主机,但看不到藏在里面的密钥。

import { redactAgentConfigForReader } from "@/lib/modules/agent/domain/config";
import { describe, expect, it } from "vitest";

const cfg = {
  systemPrompt: "p",
  model: "sonnet" as const,
  escapeHatch: { maxBudgetUsd: 1 },
  mcpServers: [
    {
      name: "docs",
      type: "http" as const,
      url: "https://user:pass@mcp.example.com/v1/mcp?token=SECRET-Q#frag",
      env: { TOKEN: "SECRET-ENV" },
    },
    { name: "plain", type: "http" as const, url: "https://mcp.example.com/open" },
    {
      name: "local",
      type: "stdio" as const,
      command: "npx",
      args: ["mcp-server", "--token=SECRET-ARG"],
    },
  ],
};

describe("redactAgentConfigForReader", () => {
  const r = redactAgentConfigForReader(cfg);
  const json = JSON.stringify(r);

  it("任何密钥都不出现:环境变量、地址的查询串与账号密码、stdio 参数", () => {
    for (const s of ["SECRET-Q", "SECRET-ENV", "SECRET-ARG", "user:pass", "frag"]) {
      expect(json).not.toContain(s);
    }
  });

  it("仍看得到用了哪些 MCP、连到哪个主机;没藏东西的地址原样", () => {
    expect(r.mcpServers?.map((m) => m.name)).toEqual(["docs", "plain", "local"]);
    expect(r.mcpServers?.[0]?.url).toBe("https://mcp.example.com/v1/mcp?***");
    expect(r.mcpServers?.[0]?.env).toEqual({ TOKEN: "***" });
    expect(r.mcpServers?.[1]?.url).toBe("https://mcp.example.com/open");
    expect(r.mcpServers?.[2]).toMatchObject({ command: "npx", args: ["***", "***"] });
  });

  it("逃生舱去掉", () => {
    expect("escapeHatch" in r).toBe(false);
  });
});
