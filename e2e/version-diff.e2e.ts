// 版本对比 —— 真实服务。

import { beforeAll, describe, expect, it } from "vitest";
import { type Client, newUser, serverUp } from "./client";

type Change = {
  path: string;
  kind: string;
  before?: unknown;
  after?: unknown;
  lines?: { op: string; text: string }[];
};
type DiffRes = { changes?: Change[]; error?: string };

describe("版本对比", () => {
  let owner: Client;
  let reader: Client;
  let stranger: Client;
  let agentId = "";
  const SECRET_V1 = "MCP-SECRET-TOKEN-1";
  const SECRET_NOW = "MCP-SECRET-TOKEN-2";

  const save = (systemPrompt: string, model = "sonnet", token = SECRET_V1) =>
    owner.post<{ agent?: { id: string }; error?: string }>("/api/agents", {
      id: agentId || undefined,
      name: "对比测试",
      config: {
        systemPrompt,
        model,
        mcpServers: [
          {
            name: "docs",
            type: "http",
            url: "https://mcp.example.com/mcp",
            env: { TOKEN: token },
          },
        ],
      },
    });
  const diff = (c: Client, from: string, to: string) =>
    c.get<DiffRes>(`/api/agents/${agentId}/versions/diff?from=${from}&to=${to}`);

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
    owner = await newUser("vdiff");
    reader = await newUser("vdiff-r");
    stranger = await newUser("vdiff-x");
    const first = await save("你是审查员。\n逐条检查。\n输出 JSON。");
    expect(first.status, first.body.error).toBeLessThan(300);
    agentId = first.body.agent?.id ?? "";
    expect((await owner.post(`/api/agents/${agentId}/versions`, { note: "v1" })).status).toBe(201);
    await save("你是审查员。\n逐条检查,标出风险。\n输出 JSON。");
    expect((await owner.post(`/api/agents/${agentId}/versions`, { note: "v2" })).status).toBe(201);
    await save("你是审查员。\n逐条检查,标出风险。\n输出 JSON。", "opus"); // 草稿只改模型
    const email = (await reader.get<{ user?: { email: string } }>("/api/auth")).body.user?.email;
    await owner.post(`/api/agents/${agentId}/share`, { target: email, permission: "read" });
  });

  it("v1 → v2:提示词改了哪一行", async () => {
    const r = await diff(owner, "1", "2");
    expect(r.status).toBe(200);
    expect(r.body.changes?.map((c) => c.path)).toEqual(["config.systemPrompt"]);
    const lines = r.body.changes?.[0]?.lines?.filter((l) => l.op !== "same");
    expect(lines).toEqual([
      { op: "del", text: "逐条检查。" },
      { op: "add", text: "逐条检查,标出风险。" },
    ]);
  });

  it("v2 → 草稿:只有模型变了", async () => {
    const r = await diff(owner, "2", "draft");
    expect(r.body.changes).toEqual([
      { path: "config.model", kind: "changed", before: "sonnet", after: "opus" },
    ]);
  });

  it("只读协作者能对比,但看到的配置已脱敏;无关的人 404;参数不对 400,版本不存在 404", async () => {
    // 草稿换了 MCP 令牌:所有者的差异里能看到它变了
    await save("你是审查员。\n逐条检查,标出风险。\n输出 JSON。", "opus", SECRET_NOW);
    const own = await diff(owner, "1", "draft");
    expect(JSON.stringify(own.body)).toContain(SECRET_NOW);
    // 只读者:两边一起脱敏,令牌一个字都不出现
    const r = await diff(reader, "1", "draft");
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(SECRET_V1);
    expect(JSON.stringify(r.body)).not.toContain(SECRET_NOW);
    expect((await diff(stranger, "1", "2")).status).toBe(404);
    expect((await diff(owner, "x", "2")).status).toBe(400);
    expect((await diff(owner, "1", "99")).status).toBe(404);
  });

  it("对比是只读的:不改变发布版本与草稿", async () => {
    const v = await owner.get<{ publishedVersion?: number }>(`/api/agents/${agentId}/versions`);
    expect(v.body.publishedVersion).toBe(2);
  });
});
