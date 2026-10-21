import { describe, expect, it } from "vitest";
import { checkMcpConfig, prepareMcpForCheck, redactSecrets } from "../mcp-check";

const defs = [
  { name: "TOKEN", required: true, secret: true },
  { name: "HOST", required: false, secret: false },
];

describe("prepareMcpForCheck", () => {
  it("按运行时的方式替换声明过的变量(普通与密钥都进 MCP),返回用到的密钥值", () => {
    const r = prepareMcpForCheck(
      { name: "m", type: "http", url: "https://{{HOST}}/mcp?token={{TOKEN}}" },
      defs,
      { TOKEN: "sk-abcdef", HOST: "mcp.example.com", OTHER: "unused-value" },
    );
    expect(r).toEqual({
      def: { name: "m", type: "http", url: "https://mcp.example.com/mcp?token=sk-abcdef" },
      secrets: expect.arrayContaining(["sk-abcdef", "mcp.example.com"]),
    });
    expect("secrets" in r && r.secrets).not.toContain("unused-value");
  });

  it("没保存值、或引用了没声明的变量:列出缺哪些(运行时同样连不上)", () => {
    expect(
      prepareMcpForCheck(
        { name: "m", type: "stdio", command: "x", env: { A: "{{TOKEN}}", B: "{{UNDECLARED}}" } },
        defs,
        { UNDECLARED: "has-value-but-undeclared" },
      ),
    ).toEqual({ missing: ["TOKEN", "UNDECLARED"] });
  });
});

describe("checkMcpConfig", () => {
  it("stdio 未启用单独标出;启用后按配置校验", () => {
    expect(checkMcpConfig({ name: "s", type: "stdio", command: "npx" }, false)?.kind).toBe(
      "stdio_disabled",
    );
    expect(checkMcpConfig({ name: "s", type: "stdio", command: "npx" }, true)).toBeNull();
    expect(checkMcpConfig({ name: "s", type: "stdio", command: " " }, true)?.kind).toBe(
      "invalid_config",
    );
  });
  it("http 缺地址、名称不合法:invalid_config", () => {
    expect(checkMcpConfig({ name: "m", type: "http" }, false)?.kind).toBe("invalid_config");
    expect(checkMcpConfig({ name: "坏 名字", type: "http", url: "https://a" }, false)?.kind).toBe(
      "invalid_config",
    );
    expect(checkMcpConfig({ name: "m", type: "http", url: "https://a/{{X}}" }, false)).toBeNull();
  });
});

describe("redactSecrets", () => {
  it("抹掉变量值、地址里的查询串与账号密码;过长截断", () => {
    const url = "https://user:pw-secret@h.example.com/mcp?token=abc-secret";
    const out = redactSecrets(
      `fail ${url} body token=abc-secret key=sk-12345 pw-secret`,
      ["sk-12345"],
      url,
    );
    expect(out).not.toMatch(/abc-secret|sk-12345|pw-secret/);
    expect(redactSecrets("x".repeat(1000), []).length).toBeLessThanOrEqual(301);
  });
});
