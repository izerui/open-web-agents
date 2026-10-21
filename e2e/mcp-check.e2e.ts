// MCP 测试连接端到端:构建器与 AI 编辑两个入口。模拟 MCP 服务放在本机内网地址上(e2e 服务放行了内网),
// 验证:变量值按本人保存的换入、缺值时说明;列出工具且从不调用工具;认证失败不回显 token;
// 回环地址始终拒绝;无编辑权限 404/403;AI 编辑用还原后的真实配置(预览是脱敏的);按账号限流。
import http from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Client, newUser, serverUp } from "./client";

type CheckResult = {
  ok: boolean;
  kind?: string;
  message?: string;
  missing?: string[];
  server?: { name?: string };
  tools?: { name: string }[];
};

const lanIp = Object.values(networkInterfaces())
  .flat()
  .find(
    (a) =>
      a &&
      a.family === "IPv4" &&
      !a.internal &&
      /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address),
  )?.address;

describe.skipIf(!lanIp || process.env.OWA_E2E_ALLOW_PRIVATE !== "1")("MCP 测试连接", () => {
  let server: http.Server;
  let base = "";
  let toolCalls = 0;
  let owner: Client;
  let agentId = "";
  const TOKEN = `tok-${Date.now()}`;

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("server unavailable");
    server = http.createServer(async (req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      if (u.searchParams.get("token") !== TOKEN) return void res.writeHead(401).end();
      if (req.method !== "POST") return void res.writeHead(405).end();
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const mcp = new McpServer({ name: "e2e-mcp", version: "1.2.3" });
      mcp.registerTool("lookup", { description: "lookup things" }, async () => {
        toolCalls += 1;
        return { content: [{ type: "text", text: "x" }] };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, JSON.parse(Buffer.concat(chunks).toString()));
    });
    await new Promise<void>((r) => server.listen(0, "0.0.0.0", () => r()));
    base = `http://${lanIp}:${(server.address() as AddressInfo).port}`;

    owner = await newUser("mcp-check");
    const created = await owner.post<{ agent: { id: string } }>("/api/agents", {
      name: "MCP 测试",
      config: {
        systemPrompt: "x",
        model: "sonnet",
        variables: [{ name: "TOKEN", required: false, secret: true }],
        mcpServers: [{ name: "lookup", type: "http", url: `${base}/mcp?token={{TOKEN}}` }],
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    agentId = created.body.agent.id;
  });

  afterAll(() => server?.close());

  const builderCheck = (c: Client, body: Record<string, unknown>) =>
    c.post<{ result: CheckResult; code?: string }>("/api/agents/mcp-check", body);
  const def = (url: string) => ({ name: "lookup", type: "http", url });
  const vars = [{ name: "TOKEN", required: false, secret: true }];

  it("构建器:没保存变量值 → 说明缺哪个;保存后列出工具,不调用工具", async () => {
    const before = await builderCheck(owner, {
      agentId,
      server: def(`${base}/mcp?token={{TOKEN}}`),
      variables: vars,
    });
    expect(before.status).toBe(200);
    expect(before.body.result).toMatchObject({
      ok: false,
      kind: "missing_variables",
      missing: ["TOKEN"],
    });

    expect((await owner.put(`/api/agents/${agentId}/variables`, { TOKEN })).status).toBe(200);
    const ok = await builderCheck(owner, {
      agentId,
      server: def(`${base}/mcp?token={{TOKEN}}`),
      variables: vars,
    });
    expect(ok.body.result).toMatchObject({
      ok: true,
      server: { name: "e2e-mcp" },
      tools: [{ name: "lookup" }],
    });
    expect(JSON.stringify(ok.body)).not.toContain(TOKEN);
    expect(toolCalls).toBe(0);
  });

  it("构建器:token 不对 → 认证失败且不回显 token;回环地址始终拒绝", async () => {
    const wrong = await builderCheck(owner, { server: def(`${base}/mcp?token=wrong-tok-123`) });
    expect(wrong.body.result).toMatchObject({ ok: false, kind: "auth" });
    expect(JSON.stringify(wrong.body)).not.toContain("wrong-tok-123");
    const port = new URL(base).port;
    const loop = await builderCheck(owner, {
      server: def(`http://127.0.0.1:${port}/mcp?token=${TOKEN}`),
    });
    expect(loop.body.result).toMatchObject({ ok: false, kind: "forbidden_address" });
  });

  it("别人的智能体:不能拿它的变量去测", async () => {
    const other = await newUser("mcp-check-other");
    const r = await builderCheck(other, {
      agentId,
      server: def(`${base}/mcp?token={{TOKEN}}`),
      variables: vars,
    });
    expect([403, 404]).toContain(r.status);
  });

  it("AI 编辑:按名称测草稿里的 MCP,用的是还原后的真实配置与本人保存的变量值", async () => {
    const design = await owner.post<{ sessionId: string }>("/api/agents/design", { agentId });
    expect(design.status).toBe(201);
    const id = design.body.sessionId;
    const r = await owner.post<{ result: CheckResult }>(`/api/agents/design/${id}/mcp-check`, {
      name: "lookup",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.result).toMatchObject({ ok: true, tools: [{ name: "lookup" }] });
    expect(toolCalls).toBe(0);
    const missing = await owner.post(`/api/agents/design/${id}/mcp-check`, { name: "nope" });
    expect(missing.status).toBe(404);
    const stranger = await newUser("mcp-check-stranger");
    expect(
      (await stranger.post(`/api/agents/design/${id}/mcp-check`, { name: "lookup" })).status,
    ).toBe(404);
  });

  it("按账号限流:每分钟 20 次,超出 429", async () => {
    const u = await newUser("mcp-check-limit");
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      statuses.push((await builderCheck(u, { server: def("http://127.0.0.1:1/mcp") })).status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});
