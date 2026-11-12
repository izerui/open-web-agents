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

test.describe("对话页与对象工作区", () => {
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

  test("对话页:会话列表、对话头与执行详情保持同一智能体", async ({ page }) => {
    await page.goto(`/chat?session=${sessions[0]}`);
    const header = page.getByRole("region", { name: "当前对话" });
    await expect(header.getByRole("heading", { level: 1 })).toHaveText("创建一个简单的 REST API");
    // 自己的智能体:名字链到构建页;对话页不再有对象页头的四个页签
    await expect(header.getByRole("link", { name: "接口开发助手", exact: true })).toHaveAttribute(
      "href",
      `/agents/${first}`,
    );
    await expect(page.getByRole("navigation", { name: "当前智能体工作区" })).toHaveCount(0);
    await expect(page.getByText("接口结构已整理。", { exact: false })).toBeVisible();
    // coze-v3:顶栏有一组空间导航,对话页处于「对话」
    await expect(
      page
        .getByRole("navigation", { name: "主导航", exact: true })
        .getByRole("link", { name: "对话" }),
    ).toHaveAttribute("aria-current", "page");
    const size = await page
      .locator("#main-content aside")
      .first()
      .evaluate((node) => node.getBoundingClientRect().width);
    expect(size).toBe(268);
    // 对话流里点一次工具调用 → 右侧执行详情定位到同一项
    await page.getByRole("button", { name: /调用了 3 个工具/ }).click();
    await page
      .getByRole("list", { name: "本轮工具调用" })
      .getByRole("button", { name: /Bash/ })
      .click();
    await expect(page.getByRole("button", { name: "执行详情", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByRole("region", { name: "调用详情" })).toContainText("尚未配置测试脚本");
    await page.getByRole("button", { name: "执行详情", exact: true }).click();
    await expect(page.getByRole("region", { name: "调用详情" })).toHaveCount(0);
    // 会话列表按时间列出所有智能体的会话,切过去对话头跟着换
    await page
      .getByRole("navigation", { name: "会话列表" })
      .getByRole("link", { name: /^整理接口文档/ })
      .click();
    await expect(header.getByRole("link", { name: "文档整理助手", exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`session=${sessions[1]}`));
  });

  test("构建页与对话页之间保持对象深链", async ({ page }) => {
    await page.goto(`/chat?session=${sessions[0]}`);
    await page
      .getByRole("region", { name: "当前对话" })
      .getByRole("link", { name: "接口开发助手", exact: true })
      .click();
    await expect(page.getByRole("heading", { level: 1, name: "接口开发助手" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/agents/${first}$`));
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
    await expect(page).toHaveURL(new RegExp(`/agents/${first}\\?stage=access`));
    await page
      .getByRole("navigation", { name: "当前智能体工作区" })
      .getByRole("link", { name: "对话", exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/chat\\?agent=${first}`));
    await expect(
      page
        .getByRole("region", { name: "当前对话" })
        .getByRole("link", { name: "接口开发助手", exact: true }),
    ).toBeVisible();
  });

  test("375px 下会话列表和执行详情改抽屉，可操作且无横向溢出", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/chat?session=${sessions[0]}`);
    await expect(page.getByText("接口结构已整理。", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "会话列表", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "会话列表" });
    await expect(drawer).toBeVisible();
    await drawer.getByRole("link", { name: /^创建一个简单的 REST API/ }).click();
    await expect(drawer).not.toBeVisible();
    await page.getByRole("button", { name: "执行详情", exact: true }).click();
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
    await page.goto(`/agents/${first}`);
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
    await expect(page).toHaveURL(new RegExp(`/agents/${first}$`));
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
    await page.goto("/agents/missing-object-workspace?stage=runs");
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
    await page.goto(`/chat?session=${sessions[0]}`);
    await expect(page.getByText("接口结构已整理。", { exact: false })).toBeVisible();
    await page.locator("[data-conversation-scroll]").evaluate((node) => {
      node.scrollTop = 0;
    });
    await page.screenshot({
      path: path.join(dir, "workbench-desktop.png"),
      style: "nextjs-portal { display:none !important }",
    });
    await page
      .getByRole("region", { name: "当前对话" })
      .getByRole("link", { name: "接口开发助手", exact: true })
      .click();
    await expect(page.getByRole("heading", { level: 1, name: "接口开发助手" })).toBeVisible();
    await expect(
      page
        .getByRole("navigation", { name: "当前智能体工作区" })
        .getByRole("link", { name: "配置", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("tab", { name: "能力", exact: true })).toBeVisible();
    await expect(page.locator(`aside a[href="/agents/${first}"]`)).toBeVisible();
    await page.screenshot({
      path: path.join(dir, "agent-config.png"),
      style: "nextjs-portal { display:none !important }",
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/chat?session=${sessions[0]}`);
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
