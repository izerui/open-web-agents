// 工作台 ?agent= 参数:构建器"试运行"、设计会话"去试运行"带着它跳过来,必须选中指定的智能体。
// 曾经初始值是 "default",只在"还没选中"时才采用参数 —— 默认智能体对所有人可见,参数永远被忽略。

import { type BrowserContext, type Page, expect, test } from "@playwright/test";

const BASE = process.env.OWA_E2E_BASE_URL ?? "http://localhost:5678";

async function register(ctx: BrowserContext, tag: string) {
  const res = await ctx.request.post(`${BASE}/api/auth`, {
    data: {
      action: "register",
      email: `pw-${tag}-${Date.now()}@example.test`,
      password: "e2e-password-123456",
    },
  });
  expect(res.ok(), `注册失败: ${res.status()}`).toBeTruthy();
}

async function createAgent(ctx: BrowserContext, name: string) {
  const res = await ctx.request.post(`${BASE}/api/agents`, {
    data: { name, config: { systemPrompt: "测试", model: "sonnet" } },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { agent?: { id: string } };
  const id = body.agent?.id;
  if (!id) throw new Error("创建智能体失败");
  return id;
}

const picker = (page: Page) => page.getByTitle("切换智能体");

test.describe("工作台 ?agent= 参数", () => {
  test("默认智能体可见时,带 ?agent= 打开选中指定的智能体;不带参数仍是默认智能体", async ({
    page,
    context,
  }) => {
    await register(context, "agent-param");
    const name = `PW 指定智能体 ${Date.now()}`;
    const agentId = await createAgent(context, name);

    await page.goto(`${BASE}/?agent=${agentId}`);
    await expect(picker(page)).toHaveText(name, { timeout: 15_000 });

    // 对照:不带参数打开,仍选中默认智能体
    await page.goto(`${BASE}/`);
    await expect(picker(page)).toHaveText("通用智能体", { timeout: 15_000 });
  });

  test("同时带 ?session= 时以会话所属的智能体为准", async ({ page, context }) => {
    await register(context, "agent-param-session");
    const agentId = await createAgent(context, `PW 参数智能体 ${Date.now()}`);
    const s = await context.request.post(`${BASE}/api/sessions`, {
      data: { agentId: "default" },
    });
    expect(s.ok()).toBeTruthy();
    const sessionId = ((await s.json()) as { session?: { id: string } }).session?.id;

    await page.goto(`${BASE}/?session=${sessionId}&agent=${agentId}`);
    await expect(picker(page)).toHaveText("通用智能体", { timeout: 15_000 });
  });
});
