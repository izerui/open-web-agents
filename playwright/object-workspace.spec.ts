import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { type APIRequestContext, expect, test } from "@playwright/test";

const BASE = process.env.OWA_E2E_BASE_URL ?? "http://localhost:5678";
const stamp = randomUUID().slice(0, 8);
const account = { email: `pw-object-${stamp}@example.test`, password: "e2e-password-123456" };
const first = `pw-object-a-${stamp}`;
const second = `pw-object-b-${stamp}`;
const sessions: string[] = [];
const agentIds: string[] = [];
let api: APIRequestContext;

test.describe("B 对象工作区", () => {
  test.beforeAll(async ({ playwright }) => {
    api = await playwright.request.newContext({ baseURL: BASE });
    expect(
      (await api.post("/api/auth", { data: { action: "register", ...account } })).ok(),
    ).toBeTruthy();
    for (const [id, name] of [
      [first, "接口开发助手"],
      [second, "文档整理助手"],
    ]) {
      const response = await api.post("/api/agents", {
        data: {
          id,
          name,
          config: { systemPrompt: "仅用于界面回归，不发起模型调用。", model: "sonnet" },
        },
      });
      expect(response.ok(), await response.text()).toBeTruthy();
      agentIds.push(id);
      const created = await api.post("/api/sessions", {
        data: { agentId: id, title: id === first ? "创建一个简单的 REST API" : "整理接口文档" },
      });
      expect(created.ok()).toBeTruthy();
      sessions.push((await created.json()).session.id);
    }
  });

  test.afterAll(async () => {
    if (!api) return;
    for (const id of sessions) await api.delete(`/api/sessions/${id}`);
    for (const id of agentIds) await api.delete(`/api/agents/${id}`);
    await api.dispose();
  });

  test.beforeEach(async ({ context, page }) => {
    expect(
      (
        await context.request.post(`${BASE}/api/auth`, { data: { action: "login", ...account } })
      ).ok(),
    ).toBeTruthy();
    await page.route("**/api/sessions/*/history", (route) =>
      route.fulfill({
        json: {
          turns: [
            {
              runId: "layout-history",
              prompt: "创建一个简单的 REST API，包含健康检查和用户列表接口。",
              running: false,
              events: [
                {
                  kind: "text",
                  text: "接口结构已整理。健康检查和用户列表使用独立路由，用户列表支持分页。",
                },
                {
                  kind: "tool_use",
                  tool: "Read",
                  input: { file_path: "README.md" },
                  toolUseId: "layout-read",
                },
                { kind: "tool_result", toolUseId: "layout-read", text: "项目说明已读取" },
                {
                  kind: "tool_use",
                  tool: "Write",
                  input: { file_path: "src/app.ts", content: "// test fixture" },
                  toolUseId: "layout-write",
                },
                { kind: "tool_result", toolUseId: "layout-write", text: "入口已生成" },
                {
                  kind: "tool_use",
                  tool: "Bash",
                  input: { command: "pnpm test" },
                  toolUseId: "layout-bash",
                },
                {
                  kind: "tool_result",
                  toolUseId: "layout-bash",
                  text: "尚未配置测试脚本",
                  isError: true,
                },
                {
                  kind: "question",
                  toolUseId: "layout-question",
                  questions: [
                    {
                      question: "用户数据先放在哪里？",
                      options: [{ label: "内存数据" }, { label: "数据库" }],
                    },
                  ],
                },
                {
                  kind: "result",
                  status: "success",
                  summary: "界面回归历史记录",
                  runId: "layout-history",
                },
              ],
            },
          ],
        },
      }),
    );
    // 回归只验证界面和导航,不允许测试误触真实运行。
    await page.route("**/api/sessions/*/run", (route) => route.abort());
  });

  test("对象树、四个页签与会话详情保持同一智能体", async ({ page }) => {
    await page.goto(`/?session=${sessions[0]}`);
    await expect(page.getByRole("heading", { level: 1, name: "接口开发助手" })).toBeVisible();
    const tabs = page.getByRole("navigation", { name: "当前智能体工作区" });
    await expect(tabs.getByRole("link")).toHaveCount(4);
    await expect(tabs.getByRole("link", { name: "配置", exact: true })).toHaveAttribute(
      "href",
      `/agents?id=${first}`,
    );
    await expect(tabs.getByRole("link", { name: "运行", exact: true })).toHaveAttribute(
      "href",
      `/settings/runs?agent=${first}`,
    );
    await expect(tabs.getByRole("link", { name: "接入", exact: true })).toHaveAttribute(
      "href",
      `/settings/keys?agent=${first}`,
    );
    await expect(page.getByText("接口结构已整理。", { exact: false })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "主导航", exact: true })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "打开的会话" })).toHaveCount(0);
    const size = await page
      .locator(".ide-layout > aside")
      .evaluate((node) => node.getBoundingClientRect().width);
    expect(size).toBe(264);
    await page.getByRole("button", { name: "查看执行详情", exact: true }).click();
    await page
      .getByRole("list", { name: "工具调用" })
      .getByRole("button", { name: /Bash/ })
      .click();
    await expect(page.getByRole("region", { name: "调用详情" })).toContainText("尚未配置测试脚本");
    await page.getByRole("button", { name: "查看执行详情", exact: true }).click();
    await page.locator(`aside a[href="/?agent=${second}"]`).click();
    await expect(page.getByRole("heading", { level: 1, name: "文档整理助手" })).toBeVisible();
    await expect(tabs.getByRole("link", { name: "运行", exact: true })).toHaveAttribute(
      "href",
      `/settings/runs?agent=${second}`,
    );
    await expect(page.locator(`aside a[href="/?session=${sessions[1]}"]`)).toBeVisible();
  });

  test("配置、运行、接入之间保持对象深链", async ({ page }) => {
    await page.goto(`/?session=${sessions[0]}`);
    await page
      .getByRole("navigation", { name: "当前智能体工作区" })
      .getByRole("link", { name: "配置", exact: true })
      .click();
    await expect(page.getByRole("heading", { level: 1, name: "接口开发助手" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/agents\\?id=${first}`));
    const request = page.waitForRequest((r) => {
      const url = new URL(r.url());
      return url.pathname === "/api/runs" && url.searchParams.get("agentId") === first;
    });
    await page
      .getByRole("navigation", { name: "当前智能体工作区" })
      .getByRole("link", { name: "运行", exact: true })
      .click();
    await request;
    await expect(page.getByRole("heading", { level: 1, name: "接口开发助手" })).toBeVisible();
    await page
      .getByRole("navigation", { name: "当前智能体工作区" })
      .getByRole("link", { name: "接入", exact: true })
      .click();
    await expect(page.getByRole("heading", { level: 1, name: "接口开发助手" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/settings/keys\\?agent=${first}`));
    await page
      .getByRole("navigation", { name: "当前智能体工作区" })
      .getByRole("link", { name: "对话", exact: true })
      .click();
    await expect(page.getByRole("heading", { level: 1, name: "接口开发助手" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`session=${sessions[0]}`));
    await expect(page.getByText("接口结构已整理。", { exact: false })).toBeVisible();
  });

  test("375px 下对象树和执行详情可操作且无横向溢出", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/?session=${sessions[0]}`);
    await expect(page.getByRole("heading", { level: 1, name: "接口开发助手" })).toBeVisible();
    await page.getByRole("button", { name: "打开智能体树" }).click();
    const drawer = page.getByRole("dialog", { name: "智能体与会话" });
    await expect(drawer).toBeVisible();
    await drawer.locator(`a[href="/?session=${sessions[0]}"]`).click();
    await expect(drawer).not.toBeVisible();
    await page.getByRole("button", { name: "查看执行详情", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "执行详情" })).toBeVisible();
    await page.keyboard.press("Escape");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBeTruthy();
    const bounds = await page.evaluate(() => ({
      messagesBottom:
        document.querySelector("[data-conversation-scroll]")?.getBoundingClientRect().bottom ??
        Number.POSITIVE_INFINITY,
      composerTop:
        document.querySelector("[data-conversation-shell] form")?.getBoundingClientRect().top ??
        Number.NEGATIVE_INFINITY,
    }));
    expect(bounds.messagesBottom).toBeLessThanOrEqual(bounds.composerTop);
  });

  test("配置分区保留草稿，离开对象前提示未保存修改", async ({ page }) => {
    await page.goto(`/agents?id=${first}`);
    const prompt = page.getByRole("textbox", { name: "系统提示词 *", exact: true });
    await prompt.fill("验证 B 工作区跨分区保留草稿");
    await page.getByRole("tab", { name: "能力", exact: true }).click();
    await page.getByRole("tab", { name: "配置", exact: true }).click();
    await expect(prompt).toHaveValue("验证 B 工作区跨分区保留草稿");
    page.once("dialog", (dialog) => void dialog.dismiss());
    await page
      .getByRole("navigation", { name: "当前智能体工作区" })
      .getByRole("link", { name: "运行", exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/agents\\?id=${first}`));
    await expect(prompt).toHaveValue("验证 B 工作区跨分区保留草稿");
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/agents") && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "保存智能体", exact: true }).click();
    expect((await saved).ok()).toBeTruthy();
    await page.reload();
    await expect(prompt).toHaveValue("验证 B 工作区跨分区保留草稿");
  });

  test("失效的对象链接不会悄悄显示全部运行", async ({ page }) => {
    const requested: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/runs") requested.push(request.url());
    });
    await page.goto("/settings/runs?agent=missing-object-workspace");
    await expect(page.getByText("找不到指定的智能体", { exact: false })).toBeVisible();
    expect(requested).toEqual([]);
  });

  test("普通账号不能进入新增的平台管理页面", async ({ context }) => {
    for (const url of ["/admin/runs", "/admin/audit", "/admin/market"]) {
      const response = await context.request.get(`${BASE}${url}`, { maxRedirects: 0 });
      expect(response.status()).toBe(307);
      expect(response.headers().location).toBe("/");
    }
  });

  test("记录 B 方案的真实页面截图", async ({ page }) => {
    const dir = path.resolve("docs/design-demos/ia-v2/implementation");
    await fs.mkdir(dir, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/?session=${sessions[0]}`);
    await expect(page.getByText("接口结构已整理。", { exact: false })).toBeVisible();
    await page.locator("[data-conversation-scroll]").evaluate((node) => {
      node.scrollTop = 0;
    });
    await page.screenshot({
      path: path.join(dir, "workbench-desktop.png"),
      style: "nextjs-portal { display:none !important }",
    });
    await page
      .getByRole("navigation", { name: "当前智能体工作区" })
      .getByRole("link", { name: "配置", exact: true })
      .click();
    await expect(page.getByRole("heading", { level: 1, name: "接口开发助手" })).toBeVisible();
    await expect(
      page
        .getByRole("navigation", { name: "当前智能体工作区" })
        .getByRole("link", { name: "配置", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("tab", { name: "能力", exact: true })).toBeVisible();
    await expect(page.locator(`aside a[href="/agents?id=${first}"]`)).toBeVisible();
    await page.screenshot({
      path: path.join(dir, "agent-config.png"),
      style: "nextjs-portal { display:none !important }",
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/?session=${sessions[0]}`);
    await expect(page.getByText("接口结构已整理。", { exact: false })).toBeVisible();
    await page.locator("[data-conversation-scroll]").evaluate((node) => {
      node.scrollTop = 0;
    });
    await page.screenshot({
      path: path.join(dir, "workbench-mobile.png"),
      style: "nextjs-portal { display:none !important }",
    });
  });
});
