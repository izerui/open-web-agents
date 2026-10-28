import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect, test } from "@playwright/test";

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
    await page.goto(`/settings/runs?agent=${first}`);
    expect((await loaded).ok()).toBeTruthy();
    await expect(page.getByRole("heading", { level: 1, name: firstName })).toBeVisible();
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((url) => url.searchParams.get("agentId") === first)).toBeTruthy();
    expect(requests.every((url) => !url.searchParams.has("scope"))).toBeTruthy();
    await expect(page.getByLabel("按智能体筛选")).toHaveCount(0);

    await page.goto("/settings/runs");
    await expect(page.getByRole("heading", { level: 1, name: "全部运行" })).toBeVisible();
    await expect(page.getByLabel("按智能体筛选")).toBeEnabled();
    const filtered = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname === "/api/runs" && url.searchParams.get("agentId") === second;
    });
    await page.getByLabel("按智能体筛选").selectOption(second);
    await filtered;
    await expect(page).toHaveURL(`${BASE}/settings/runs`);
    await expect(page.getByRole("navigation", { name: "当前智能体工作区" })).toHaveCount(0);
    await expect(page.getByLabel("全平台", { exact: true })).toHaveCount(0);
  });

  test("不存在或为空的运行对象不会回退到未筛选请求", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/runs") requests.push(request.url());
    });
    for (const id of [`missing-${stamp}`, ""]) {
      await page.goto(`/settings/runs?agent=${id}`);
      await expect(page.locator('[data-slot="alert"]')).toContainText(
        id ? "找不到指定的智能体" : "链接缺少智能体 ID",
      );
      await expect(page.getByRole("navigation", { name: "当前智能体工作区" })).toHaveCount(0);
      await expect(page.getByRole("table")).toHaveCount(0);
      expect(requests).toEqual([]);
    }
  });

  test("不存在或为空的接入对象不会展示另一个智能体的契约或签发控件", async ({ page }) => {
    for (const id of [`missing-${stamp}`, ""]) {
      await page.goto(`/settings/keys?agent=${id}`);
      await expect(page.locator('[data-slot="alert"]')).toContainText(
        id ? "找不到指定的智能体" : "链接缺少智能体 ID",
      );
      await expect(page.getByRole("navigation", { name: "当前智能体工作区" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "签发", exact: true })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "OpenAPI 文档" })).toHaveCount(0);
    }
    await page.getByLabel("选择接入智能体").selectOption(first);
    await expect(page).toHaveURL(`${BASE}/settings/keys?agent=${first}`);
    await expect(page.getByRole("heading", { level: 1, name: firstName })).toBeVisible();
    await expect(page.getByLabel("选择接入智能体")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "OpenAPI 文档" })).toHaveAttribute(
      "href",
      `/api/agents/${first}/openapi.json`,
    );
  });

  test("全局显示账号全部 Key，对象切换与返回保留独立凭证绑定", async ({ page }) => {
    await page.goto("/settings/keys");
    await expect(page.getByText("我的 API Key", { exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "当前智能体工作区" })).toHaveCount(0);
    for (const id of [first, second, "all"]) {
      await expect(page.getByText(`scope-${id}-${stamp}`)).toBeVisible();
    }
    await expect(page.getByLabel("限定智能体")).toHaveValue("");
    await page.getByLabel("限定智能体").selectOption(second);
    await page.getByLabel("选择接入智能体").selectOption(first);
    await expect(page).toHaveURL(`${BASE}/settings/keys?agent=${first}`);
    await expect(page.getByRole("heading", { level: 1, name: firstName })).toBeVisible();
    await expect(page.getByLabel("限定智能体")).toHaveValue(second);
    await expect(page.getByText("可用于此智能体的 API Key", { exact: true })).toBeVisible();
    await expect(page.getByText(`scope-${first}-${stamp}`)).toBeVisible();
    await expect(page.getByText(`scope-all-${stamp}`)).toBeVisible();
    await expect(page.getByText(`scope-${second}-${stamp}`)).toHaveCount(0);
    await page.getByRole("link", { name: "全部 API Key", exact: true }).click();
    await expect(page).toHaveURL(`${BASE}/settings/keys`);
    await expect(page.getByText("我的 API Key", { exact: true })).toBeVisible();
    await expect(page.getByLabel("限定智能体")).toHaveValue(second);
    await expect(page.getByText(`scope-${second}-${stamp}`)).toBeVisible();
  });
});
