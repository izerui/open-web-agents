import { randomUUID } from "node:crypto";
import { type APIRequestContext, type Page, expect, test } from "@playwright/test";

const BASE = process.env.OWA_E2E_BASE_URL ?? "http://localhost:5678";
const stamp = randomUUID().slice(0, 8);
const account = {
  email: `pw-access-context-${stamp}@example.test`,
  password: "e2e-password-123456",
};
const first = `pw-access-a-${stamp}`;
const second = `pw-access-b-${stamp}`;
const firstName = `接入边界 A ${stamp}`;
const secondName = `接入边界 B ${stamp}`;
const keyIds: string[] = [];
const agentIds: string[] = [];
let api: APIRequestContext;

/** 构建页页头里的智能体名称(页头不是 h1,按「返回工作室」所在的页头定位) */
const buildTitle = (page: Page, name: string) =>
  page
    .locator("header")
    .filter({ has: page.getByRole("link", { name: "返回工作室" }) })
    .getByText(name, { exact: true });
const stageNav = (page: Page) => page.getByRole("navigation", { name: "构建阶段" });

test.describe("运行与接入的对象边界", () => {
  test.beforeAll(async ({ playwright }) => {
    api = await playwright.request.newContext({ baseURL: BASE });
    const registered = await api.post("/api/auth", {
      data: { action: "register", ...account },
    });
    expect(registered.ok()).toBeTruthy();
    for (const [id, name] of [
      [first, firstName],
      [second, secondName],
    ]) {
      const created = await api.post("/api/agents", {
        data: { id, name, config: { systemPrompt: "仅验证页面与凭证边界，不调用模型。" } },
      });
      expect(created.ok(), await created.text()).toBeTruthy();
      agentIds.push(id);
    }
    for (const agentId of [first, second, undefined]) {
      const created = await api.post("/api/keys", {
        data: { name: `scope-${agentId ?? "all"}-${stamp}`, agentId },
      });
      expect(created.ok()).toBeTruthy();
      keyIds.push((await created.json()).key.id);
    }
  });

  test.afterAll(async () => {
    if (!api) return;
    for (const id of keyIds) await api.delete(`/api/keys?id=${id}`);
    for (const id of agentIds) await api.delete(`/api/agents/${id}`);
    await api.dispose();
  });

  test.beforeEach(async ({ context }) => {
    const login = await context.request.post(`${BASE}/api/auth`, {
      data: { action: "login", ...account },
    });
    expect(login.ok()).toBeTruthy();
  });

  test("对象运行的首个请求已限定智能体，全局筛选不变成对象页", async ({ page }) => {
    const requests: URL[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/runs") requests.push(url);
    });
    const loaded = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/runs",
    );
    await page.goto(`/agents/${first}?stage=runs`);
    expect((await loaded).ok()).toBeTruthy();
    await expect(buildTitle(page, firstName)).toBeVisible();
    await expect(stageNav(page).getByRole("button", { name: /^运行/ })).toHaveAttribute(
      "aria-current",
      "step",
    );
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((url) => url.searchParams.get("agentId") === first)).toBeTruthy();
    expect(requests.every((url) => !url.searchParams.has("scope"))).toBeTruthy();
    await expect(page.getByLabel("按智能体筛选")).toHaveCount(0);

    await page.goto("/developer/runs");
    await expect(page.getByRole("heading", { level: 1, name: "运行记录" })).toBeVisible();
    await expect(page.getByLabel("按智能体筛选")).toBeEnabled();
    const filtered = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname === "/api/runs" && url.searchParams.get("agentId") === second;
    });
    await page.getByLabel("按智能体筛选").selectOption(second);
    await filtered;
    await expect(page).toHaveURL(`${BASE}/developer/runs`);
    await expect(stageNav(page)).toHaveCount(0);
    await expect(page.getByLabel("全平台", { exact: true })).toHaveCount(0);
  });

  test("不存在或为空的运行对象不会回退到未筛选请求", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/runs") requests.push(request.url());
    });
    // 带 agent 的旧地址重定向到该智能体构建页的「运行」阶段;智能体不存在时构建页显示找不到,不渲染运行列表
    await page.goto(`/settings/runs?agent=missing-${stamp}`);
    await expect(page).toHaveURL(`${BASE}/agents/missing-${stamp}?stage=runs`);
    await expect(page.getByText("找不到这个智能体", { exact: true })).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(0);
    expect(requests).toEqual([]);
    // agent 为空:留在开发者空间的运行记录,提示缺少 ID
    await page.goto("/settings/runs?agent=");
    await expect(page.locator('[data-slot="alert"]')).toContainText("链接缺少智能体 ID");
    await expect(stageNav(page)).toHaveCount(0);
    await expect(page.getByRole("table")).toHaveCount(0);
    expect(requests).toEqual([]);
  });

  test("不存在或为空的接入对象不会展示另一个智能体的契约或签发控件", async ({ page }) => {
    // 带 agent 的旧地址重定向到该智能体构建页的「接入」阶段;智能体不存在时构建页显示找不到,没有签 Key 与文档入口
    await page.goto(`/settings/keys?agent=missing-${stamp}`);
    await expect(page).toHaveURL(`${BASE}/agents/missing-${stamp}?stage=access`);
    await expect(page.getByText("找不到这个智能体", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^签发 Key（仅/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "OpenAPI 文档" })).toHaveCount(0);
    // agent 为空:落到账号级的 Key 页(没有单智能体模式),不出现任何智能体的接入内容
    await page.goto("/settings/keys?agent=");
    await expect(page.getByRole("heading", { level: 1, name: "API Key 与签名密钥" })).toBeVisible();
    await expect(stageNav(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^签发 Key（仅/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "OpenAPI 文档" })).toHaveCount(0);
    // 接入中心的「选择接入智能体」下拉已随接入中心删除;按智能体进入接入阶段的入口见下一个用例
    await page.goto(`/agents/${first}?stage=access`);
    await expect(buildTitle(page, firstName)).toBeVisible();
    await page.getByRole("button", { name: "OpenAPI 文档" }).click();
    await expect(
      page.getByRole("link", { name: `/api/agents/${first}/openapi.json`, exact: true }),
    ).toHaveAttribute("href", `/api/agents/${first}/openapi.json`);
  });

  test("开发者页显示账号全部 Key，按智能体的接入入口落到构建页", async ({ page }) => {
    await page.goto("/developer/keys");
    await expect(page.getByRole("heading", { level: 1, name: "API Key 与签名密钥" })).toBeVisible();
    await expect(stageNav(page)).toHaveCount(0);
    for (const id of [first, second, "all"]) {
      await expect(page.getByText(`scope-${id}-${stamp}`)).toBeVisible();
    }
    await expect(page.getByLabel("限定智能体")).toHaveValue("");
    await page
      .getByRole("region", { name: "按智能体查看调用文档" })
      .getByRole("link", { name: new RegExp(firstName) })
      .click();
    await expect(page).toHaveURL(`${BASE}/agents/${first}?stage=access`);
    await expect(buildTitle(page, firstName)).toBeVisible();
    await expect(page.getByText("限定本智能体的 API Key", { exact: true })).toBeVisible();
    await expect(page.getByText(`scope-${first}-${stamp}`)).toBeVisible();
    // 接入阶段只列限定本智能体的 Key,账号级(不限定智能体)的 Key 在开发者页管理,不再断言 scope-all 出现在这里
    await expect(page.getByText(`scope-${second}-${stamp}`)).toHaveCount(0);
    await page.getByRole("link", { name: "管理全部 Key 与签名密钥", exact: true }).click();
    await expect(page).toHaveURL(`${BASE}/developer/keys`);
    // 旧的单智能体地址重定向到构建页
    await page.goto(`/developer/keys?agent=${second}`);
    await expect(page).toHaveURL(`${BASE}/agents/${second}?stage=access`);
  });
});
