// 知识库编辑浏览器验收:
//   添加 → 展开 → 编辑 → 保存 → 重新打开确认新内容
//   + 延迟 PUT 场景: A 保存慢 → 切文档 B → A 返回不影响 B

import { type BrowserContext, type Locator, expect, test } from "@playwright/test";

const BASE = process.env.OWA_E2E_BASE_URL ?? "http://localhost:5678";

async function register(ctx: BrowserContext, tag: string) {
  const email = `pw-${tag}-${Date.now()}@example.test`;
  const res = await ctx.request.post(`${BASE}/api/auth`, {
    data: { action: "register", email, password: "e2e-password-123456" },
  });
  expect(res.ok(), `注册失败: ${res.status()}`).toBeTruthy();
  return email;
}

async function createAgent(ctx: BrowserContext, name: string) {
  const res = await ctx.request.post(`${BASE}/api/agents`, {
    data: { name, config: { systemPrompt: "测试", model: "sonnet" } },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { agent?: { id: string } };
  return body.agent!.id;
}

async function addDoc(ctx: BrowserContext, agentId: string, title: string, content: string) {
  const res = await ctx.request.post(`${BASE}/api/agents/${agentId}/knowledge`, {
    data: { title, content },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { doc?: { id: string } };
  return body.doc!.id;
}

function knowledgePanel(page: import("@playwright/test").Page): Locator {
  return page.locator("text=知识库").locator("..").locator("..").locator("..");
}

function docPre(panel: Locator): Locator {
  return panel.locator(".border-t pre");
}

test.describe("知识库编辑浏览器验收", () => {
  test("添加 → 展开 → 编辑 → 保存 → 重新打开确认新内容", async ({ page, context }) => {
    await register(context, "kb-pw");
    const agentId = await createAgent(context, "PW 知识验收");
    await addDoc(context, agentId, "二叉树基础", "二叉树是一种树形数据结构，每个节点最多有两个子节点。");

    await page.goto(`${BASE}/agents?id=${agentId}`);
    const panel = knowledgePanel(page);
    await expect(panel.getByText("二叉树基础")).toBeVisible({ timeout: 15_000 });

    // 展开文档
    await panel.getByText("二叉树基础").click();
    await expect(docPre(panel)).toContainText("二叉树是一种树形数据结构", { timeout: 5_000 });

    // 点编辑
    await panel.getByRole("button", { name: "编辑" }).click();

    // 修改标题
    const editArea = panel.locator(".border-t");
    await editArea.locator("input").clear();
    await editArea.locator("input").fill("哈希表原理");

    // 修改正文
    await editArea.locator("textarea").clear();
    await editArea.locator("textarea").fill("哈希表通过散列函数将键映射到桶位置。");

    // 保存
    await panel.getByRole("button", { name: "保存" }).click();

    // 等保存完成
    await expect(docPre(panel)).toContainText("哈希表通过散列函数", { timeout: 5_000 });
    await expect(panel.getByText("哈希表原理")).toBeVisible();

    // 收起再展开
    await panel.getByText("哈希表原理").click();
    await expect(docPre(panel)).not.toBeVisible();
    await panel.getByText("哈希表原理").click();
    await expect(docPre(panel)).toContainText("哈希表通过散列函数", { timeout: 5_000 });
    await expect(docPre(panel)).not.toContainText("二叉树");
  });

  test("清空正文被阻止并提示", async ({ page, context }) => {
    await register(context, "kb-empty");
    const agentId = await createAgent(context, "PW 空正文验收");
    await addDoc(context, agentId, "测试文档", "原始正文内容不为空");

    await page.goto(`${BASE}/agents?id=${agentId}`);
    const panel = knowledgePanel(page);
    await expect(panel.getByText("测试文档")).toBeVisible({ timeout: 15_000 });

    // 展开 → 编辑 → 清空正文 → 保存
    await panel.getByText("测试文档").click();
    await expect(docPre(panel)).toContainText("原始正文内容", { timeout: 5_000 });
    await panel.getByRole("button", { name: "编辑" }).click();

    const editArea = panel.locator(".border-t");
    await editArea.locator("textarea").clear();
    await panel.getByRole("button", { name: /保存/ }).click();

    // 应提示错误，不静默跳过
    await expect(panel.getByText("正文不能为空")).toBeVisible({ timeout: 3_000 });

    // 取消编辑，重新打开——原始内容应该还在
    await panel.getByRole("button", { name: "取消" }).click();
    await expect(docPre(panel)).toContainText("原始正文内容");
  });

  test("A 保存慢 → 切到 B → A 返回不影响 B 的展示", async ({ page, context }) => {
    await register(context, "kb-race");
    const agentId = await createAgent(context, "PW 竞态验收");
    const docAId = await addDoc(context, agentId, "文档A", "文档A的原始正文内容");
    const docBId = await addDoc(context, agentId, "文档B", "文档B的原始正文内容");

    await page.goto(`${BASE}/agents?id=${agentId}`);
    const panel = knowledgePanel(page);
    await expect(panel.getByText("文档A")).toBeVisible({ timeout: 15_000 });

    // 展开 A 并进入编辑
    await panel.getByText("文档A").click();
    await expect(docPre(panel)).toContainText("文档A的原始正文", { timeout: 5_000 });
    await panel.getByRole("button", { name: "编辑" }).click();

    const editArea = panel.locator(".border-t");
    await editArea.locator("textarea").clear();
    await editArea.locator("textarea").fill("文档A的修改后正文");

    // 拦截 PUT 请求——延迟 3 秒
    let putIntercepted = false;
    await page.route(`**/api/agents/${agentId}/knowledge`, async (route) => {
      if (route.request().method() === "PUT") {
        putIntercepted = true;
        await new Promise((r) => setTimeout(r, 3000));
        await route.continue();
      } else {
        await route.continue();
      }
    });

    // 点保存（会被延迟）
    await panel.getByRole("button", { name: /保存/ }).click();
    await page.waitForTimeout(500);

    // 不等保存完成，收起 A 展开 B
    await panel.getByRole("button", { name: "文档A", exact: true }).click();
    await panel.getByRole("button", { name: "文档B", exact: true }).click();
    await expect(docPre(panel)).toContainText("文档B的原始正文", { timeout: 5_000 });

    // 等 A 的 PUT 完成
    await page.waitForTimeout(4000);
    expect(putIntercepted).toBe(true);

    // B 的展开区仍然显示 B 的内容
    await expect(docPre(panel)).toContainText("文档B的原始正文");
    await expect(docPre(panel)).not.toContainText("文档A");

    await page.unroute(`**/api/agents/${agentId}/knowledge`);

    // 验证 A 确实被保存了
    const res = await context.request.get(`${BASE}/api/agents/${agentId}/knowledge/${docAId}`);
    const body = (await res.json()) as { content: string };
    expect(body.content).toBe("文档A的修改后正文");

    // 关键: B 的编辑→保存仍可用(saving 没有卡住)
    await panel.getByRole("button", { name: "编辑" }).click();
    const editArea2 = panel.locator(".border-t");
    await editArea2.locator("textarea").clear();
    await editArea2.locator("textarea").fill("文档B的修改后正文");
    await panel.getByRole("button", { name: /保存/ }).click();
    await expect(docPre(panel)).toContainText("文档B的修改后正文", { timeout: 5_000 });

    // API 验证 B 也确实保存了
    const resB = await context.request.get(`${BASE}/api/agents/${agentId}/knowledge/${docBId}`);
    const bodyB = (await resB.json()) as { content: string };
    expect(bodyB.content).toBe("文档B的修改后正文");
  });
});
