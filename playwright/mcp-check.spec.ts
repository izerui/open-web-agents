// MCP 测试连接的界面验收:构建器里每个 MCP 都有"测试连接",成功显示服务名与工具列表(未调用);
// 失败显示原因;改了配置清掉旧结果。AI 编辑里对已保存草稿中的 MCP 同样可以测试。
// 模拟 MCP 服务放在本机内网地址上,服务须以 OWA_WEBHOOK_ALLOW_PRIVATE=1 启动(OWA_E2E_ALLOW_PRIVATE=1 告知)。

import http from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { type BrowserContext, expect, test } from "@playwright/test";

const BASE = process.env.OWA_E2E_BASE_URL ?? "http://localhost:5678";
const lanIp = Object.values(networkInterfaces())
  .flat()
  .find(
    (a) =>
      a &&
      a.family === "IPv4" &&
      !a.internal &&
      /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address),
  )?.address;

async function register(ctx: BrowserContext, tag: string) {
  const res = await ctx.request.post(`${BASE}/api/auth`, {
    data: {
      action: "register",
      email: `pw-${tag}-${Date.now()}@example.test`,
      password: "e2e-password-123456",
    },
  });
  expect(res.ok()).toBeTruthy();
}

test.describe("MCP 测试连接", () => {
  test.skip(!lanIp || process.env.OWA_E2E_ALLOW_PRIVATE !== "1", "需要本机内网地址且服务放行内网");
  let server: http.Server;
  let mcpBase = "";
  let toolCalls = 0;

  test.beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      if (req.method !== "POST") return void res.writeHead(405).end();
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const mcp = new McpServer({ name: "pw-mcp", version: "2.0.0" });
      for (const name of ["search_docs", "send_mail"]) {
        mcp.registerTool(name, { description: `${name} 工具` }, async () => {
          toolCalls += 1;
          return { content: [{ type: "text", text: "x" }] };
        });
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, JSON.parse(Buffer.concat(chunks).toString()));
    });
    await new Promise<void>((r) => server.listen(0, "0.0.0.0", () => r()));
    mcpBase = `http://${lanIp}:${(server.address() as AddressInfo).port}`;
  });
  test.afterAll(() => server?.close());

  test("构建器:测试连接显示工具列表;改地址后旧结果清掉;连不上显示原因", async ({
    page,
    context,
  }) => {
    await register(context, "mcp-builder");
    const created = await context.request.post(`${BASE}/api/agents`, {
      data: {
        name: "PW MCP 测试",
        config: {
          systemPrompt: "x",
          model: "sonnet",
          mcpServers: [{ name: "docs", type: "http", url: `${mcpBase}/mcp` }],
        },
      },
    });
    expect(created.ok()).toBeTruthy();
    const id = ((await created.json()) as { agent: { id: string } }).agent.id;

    await page.goto(`${BASE}/agents?id=${id}`);
    await page.getByRole("tab", { name: "能力", exact: true }).click();
    await page.getByRole("button", { name: "测试连接 docs" }).click();
    const ok = page.getByTestId("mcp-check-ok");
    await expect(ok).toContainText("连接成功:pw-mcp 2.0.0");
    await expect(ok).toContainText("2 个工具(未调用)");
    await expect(ok).toContainText("search_docs");
    await expect(ok).toContainText("send_mail 工具");
    expect(toolCalls).toBe(0);

    // 改成回环地址:旧结果清掉,再测显示原因
    const url = page.locator(`input[value="${mcpBase}/mcp"]`);
    await url.fill("http://127.0.0.1:9/mcp");
    await expect(ok).toHaveCount(0);
    await page.getByRole("button", { name: "测试连接 docs" }).click();
    await expect(page.getByTestId("mcp-check-failed")).toContainText("不允许连接的地址");
  });

  test("AI 编辑:已保存草稿里的 MCP 可以测试", async ({ page, context }) => {
    await register(context, "mcp-design");
    const created = await context.request.post(`${BASE}/api/agents`, {
      data: {
        name: "PW 设计 MCP",
        config: {
          systemPrompt: "x",
          model: "sonnet",
          mcpServers: [{ name: "docs", type: "http", url: `${mcpBase}/mcp` }],
        },
      },
    });
    const id = ((await created.json()) as { agent: { id: string } }).agent.id;
    const design = await context.request.post(`${BASE}/api/agents/design`, {
      data: { agentId: id },
    });
    const sessionId = ((await design.json()) as { sessionId: string }).sessionId;
    await page.goto(`${BASE}/agents/design?session=${sessionId}`);
    await page.getByRole("button", { name: "测试连接 docs" }).click();
    await expect(page.getByTestId("mcp-check-ok")).toContainText("search_docs");
    expect(toolCalls).toBe(0);
  });
});
