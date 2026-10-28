import { randomUUID } from "node:crypto";
import { type BrowserContext, type Page, type Route, expect, test } from "@playwright/test";

const account = {
  email: `pw-object-state-${randomUUID().slice(0, 8)}@example.test`,
  password: "e2e-password-123456",
};
let authCookies: Parameters<BrowserContext["addCookies"]>[0] = [];
const prompt = (page: Page) => page.getByRole("textbox", { name: "系统提示词 *", exact: true });
const save = (page: Page) => page.getByRole("button", { name: "保存智能体", exact: true });
const tabs = (page: Page) => page.getByRole("navigation", { name: "当前智能体工作区" });

async function fixture(page: Page) {
  let agents = [
    ["default", "通用智能体"],
    ["review-a", "审查智能体 A"],
    ["review-b", "审查智能体 B"],
  ].map(([id, name]) => ({
    id,
    name,
    canWrite: true,
    canRead: true,
    canManageWebhook: true,
    config: { model: "sonnet", systemPrompt: `${name} 已保存提示词`, maxTurns: 20 },
    publishedVersion: null,
  }));
  const sessions = [
    { id: "review-default-session", agentId: "default", title: "默认历史会话" },
    { id: "review-a-session", agentId: "review-a", title: "A 历史会话" },
  ].map((session) => ({ ...session, createdAt: "2026-10-27T00:00:00Z" }));
  let pending: Route | undefined;
  let hold = false;
  const submitted: Record<string, unknown>[] = [];
  const complete = async (route: Route) => {
    const body = route.request().postDataJSON();
    agents = agents.map((agent) => (agent.id === body.id ? { ...agent, ...body } : agent));
    await route.fulfill({ json: { agent: agents.find((agent) => agent.id === body.id) } });
  };
  await page.route("**/api/agents", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fulfill({ json: { agents } });
      return;
    }
    submitted.push(route.request().postDataJSON());
    if (hold) pending = route;
    else await complete(route);
  });
  await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions } }));
  await page.route("**/api/sessions/*/history", (route) => route.fulfill({ json: { turns: [] } }));
  await page.route("**/api/runs?*", (route) => route.fulfill({ json: { items: [] } }));
  return {
    submitted,
    hold: () => {
      hold = true;
    },
    release: async () => {
      await expect.poll(() => Boolean(pending)).toBe(true);
      hold = false;
      await complete(pending as Route);
    },
  };
}

test.beforeAll(async ({ request }) => {
  expect(
    (await request.post("/api/auth", { data: { action: "register", ...account } })).ok(),
  ).toBeTruthy();
  authCookies = (await request.storageState()).cookies;
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(authCookies);
});

test("保存 A 的迟到响应不能改写 B 的对象身份或表单", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/agents?id=review-a");
  await expect(prompt(page)).toHaveValue("审查智能体 A 已保存提示词");
  await prompt(page).fill("A 保存快照");
  state.hold();
  await save(page).click();
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("link", { name: "审查智能体 B", exact: true }).click();
  await expect(prompt(page)).toHaveValue("审查智能体 B 已保存提示词");
  await state.release();
  await expect(save(page)).toBeDisabled();
  await expect(page).toHaveURL(/\/agents\?id=review-b$/);
  await expect(page.getByRole("heading", { level: 1, name: "审查智能体 B" })).toBeVisible();
  await prompt(page).fill("B 修改");
  await save(page).click();
  await expect.poll(() => state.submitted.length).toBe(2);
  expect(state.submitted[1]).toMatchObject({
    id: "review-b",
    config: { systemPrompt: "B 修改" },
  });
});

test("保存期间继续编辑同一对象，新内容仍待保存；对象树同步改名", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/agents?id=review-a");
  await expect(prompt(page)).toHaveValue("审查智能体 A 已保存提示词");
  await page.getByRole("textbox", { name: "名称 *", exact: true }).fill("A 新名称");
  state.hold();
  await save(page).click();
  await prompt(page).fill("保存发出后的新编辑");
  await state.release();
  await expect(save(page)).toBeEnabled();
  await expect(prompt(page)).toHaveValue("保存发出后的新编辑");
  await expect(page.getByRole("link", { name: "A 新名称", exact: true })).toBeVisible();
  await save(page).click();
  await expect(save(page)).toBeDisabled();
  expect(state.submitted[1]).toMatchObject({
    id: "review-a",
    config: { systemPrompt: "保存发出后的新编辑" },
  });
});

test("搜索跳转可以取消，离开后迟到的保存不改变页面", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/agents?id=review-a");
  await expect(prompt(page)).toHaveValue("审查智能体 A 已保存提示词");
  await prompt(page).fill("仍未保存");
  await page.getByRole("button", { name: "搜索页面与会话" }).click();
  await page.getByPlaceholder("搜索页面…").fill("全部运行");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("option", { name: "全部运行" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page).toHaveURL(/\/agents\?id=review-a$/);
  await page.keyboard.press("Escape");
  await expect(prompt(page)).toHaveValue("仍未保存");
  await page.getByRole("textbox", { name: "名称 *", exact: true }).fill("离开后保存的 A");
  state.hold();
  await save(page).click();
  await page.getByRole("button", { name: "搜索页面与会话" }).click();
  await page.getByPlaceholder("搜索页面…").fill("全部运行");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("option", { name: "全部运行" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "全部运行" })).toBeVisible();
  await state.release();
  await expect(page.getByRole("link", { name: "离开后保存的 A", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/runs$/);
});

test("AI 编辑草稿也能取消搜索跳转", async ({ page }) => {
  await fixture(page);
  await page.route("**/api/agents/design", (route) =>
    route.fulfill({ json: { sessions: [{ id: "review-design", title: "审查设计" }] } }),
  );
  await page.route("**/api/agents/design/review-design", (route) =>
    route.fulfill({
      json: {
        sessionId: "review-design",
        legacy: false,
        busy: false,
        resources: [],
        draft: {
          name: "原设计",
          description: "",
          systemPrompt: "已保存的设计",
          parameters: {},
          skillRefs: [],
          mcpRefs: [],
        },
      },
    }),
  );
  await page.goto("/agents/design?session=review-design");
  await page.getByLabel("名称", { exact: true }).fill("未保存的设计");
  await page.getByRole("button", { name: "搜索页面与会话" }).click();
  await page.getByPlaceholder("搜索页面…").fill("全部运行");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("option", { name: "全部运行" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page).toHaveURL(/\/agents\/design\?session=review-design$/);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("option", { name: "全部运行" }).click();
  await expect(page).toHaveURL(/\/settings\/runs$/);
});

test("跨对象配置返回对话，不清除默认对象的会话记忆；新会话仍可清除当前记忆", async ({ page }) => {
  await fixture(page);
  await page.goto("/?session=review-default-session");
  const remembered = (id: string) =>
    page.evaluate((agentId) => {
      const key = Object.keys(sessionStorage).find(
        (key) => key.startsWith("owa.object-session:") && key.endsWith(`:${agentId}`),
      );
      return key ? sessionStorage.getItem(key) : null;
    }, id);
  await expect.poll(() => remembered("default")).toBe("review-default-session");
  await page.getByRole("button", { name: "展开 审查智能体 A 的会话" }).click();
  await page.getByRole("link", { name: "A 历史会话", exact: true }).click();
  await expect.poll(() => remembered("review-a")).toBe("review-a-session");
  await tabs(page).getByRole("link", { name: "配置" }).click();
  await expect(prompt(page)).toHaveValue("审查智能体 A 已保存提示词");
  await tabs(page).getByRole("link", { name: "对话" }).click();
  await expect(page.locator("[data-conversation-shell] textarea")).toBeEnabled();
  await expect.poll(() => remembered("review-a")).toBe("review-a-session");
  expect(await remembered("default")).toBe("review-default-session");
  await page.getByRole("link", { name: "新建会话", exact: true }).click();
  await expect.poll(() => remembered("review-a")).toBeNull();
  expect(await remembered("default")).toBe("review-default-session");
});

test("无效或空对象链接禁止发送，用户显式选择后恢复；有效会话优先", async ({ page }) => {
  await fixture(page);
  for (const id of ["missing-review-agent", ""]) {
    await page.goto(`/?agent=${id}`);
    await expect(
      page.locator("output").filter({ hasText: id ? "找不到指定的智能体" : "链接缺少智能体 ID" }),
    ).toContainText(id ? "找不到指定的智能体" : "链接缺少智能体 ID");
    await expect(page.locator("[data-conversation-shell] textarea")).toBeDisabled();
    await expect(tabs(page)).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/\\?agent=${id}$`));
    await page.getByRole("link", { name: "审查智能体 A", exact: true }).click();
    await expect(page.locator("[data-conversation-shell] textarea")).toBeEnabled();
    await expect(page.getByRole("heading", { level: 1, name: "审查智能体 A" })).toBeVisible();
  }
  await page.goto("/?agent=missing-review-agent&session=review-a-session");
  await expect(page.getByRole("heading", { level: 1, name: "审查智能体 A" })).toBeVisible();
  await expect(page.locator("[data-conversation-shell] textarea")).toBeEnabled();
});

test("切换会话后迟到的审批不出现在新会话", async ({ page }) => {
  await fixture(page);
  let pending: Route | undefined;
  await page.route("**/api/sessions/review-default-session/approvals", (route) => {
    pending = route;
  });
  let nextPoll: Route | undefined;
  await page.route("**/api/sessions/review-a-session/approvals", (route) => {
    nextPoll = route;
  });
  await page.goto("/?session=review-default-session");
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.getByRole("button", { name: "展开 审查智能体 A 的会话" }).click();
  await page.getByRole("link", { name: "A 历史会话", exact: true }).click();
  await expect.poll(() => Boolean(nextPoll)).toBe(true);
  await pending?.fulfill({
    json: {
      pending: [
        {
          id: "approval-old",
          toolName: "Bash",
          summary: "只属于默认会话的审批",
          reason: "人工确认",
          expiresAt: Date.now() + 600_000,
        },
      ],
      grants: [],
    },
  });
  // Allow the released response and its effects to commit before asserting absence.
  await page.waitForTimeout(150);
  await expect(page.getByText("只属于默认会话的审批", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "审查智能体 A" })).toBeVisible();
  await nextPoll?.fulfill({ json: { pending: [], grants: [] } });
});

test("创建会话期间离开工作台，迟到响应不改写配置 URL 或发起运行", async ({ page }) => {
  await fixture(page);
  let pending: Route | undefined;
  const runPosts: string[] = [];
  await page.route("**/api/sessions", (route) => {
    if (route.request().method() === "POST") {
      pending = route;
      return;
    }
    return route.fulfill({ json: { sessions: [] } });
  });
  await page.route("**/api/sessions/*/run", (route) => {
    runPosts.push(route.request().url());
    return route.fulfill({ status: 400, json: { error: "测试禁止模型调用" } });
  });
  await page.goto("/?agent=review-a");
  const input = page.locator("[data-conversation-shell] textarea");
  await expect(input).toBeEnabled();
  await input.fill("仅测试迟到响应");
  await input.press("Enter");
  await expect.poll(() => Boolean(pending)).toBe(true);
  await tabs(page).getByRole("link", { name: "配置" }).click();
  await expect(prompt(page)).toHaveValue("审查智能体 A 已保存提示词");
  await pending?.fulfill({ json: { session: { id: "late-session", agentId: "review-a" } } });
  await page.waitForTimeout(150);
  await expect(page).toHaveURL(/\/agents\?id=review-a$/);
  expect(runPosts).toEqual([]);
});

test("删除 A 期间切到 B，删除完成不清空 B 编辑器", async ({ page }) => {
  await fixture(page);
  let pending: Route | undefined;
  await page.route("**/api/agents/review-a", (route) => {
    pending = route;
  });
  await page.goto("/agents?id=review-a");
  await expect(prompt(page)).toHaveValue("审查智能体 A 已保存提示词");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.getByRole("link", { name: "审查智能体 B", exact: true }).click();
  await expect(prompt(page)).toHaveValue("审查智能体 B 已保存提示词");
  await pending?.fulfill({ json: { ok: true } });
  await page.waitForTimeout(150);
  await expect(page).toHaveURL(/\/agents\?id=review-b$/);
  await expect(prompt(page)).toHaveValue("审查智能体 B 已保存提示词");
});

test("登出失败保留当前页面与账号，不显示成功", async ({ page }) => {
  await fixture(page);
  await page.route("**/api/auth", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({ status: 503, json: { error: "登出服务不可用" } });
    } else await route.continue();
  });
  await page.goto("/agents?id=review-a");
  await expect(prompt(page)).toHaveValue("审查智能体 A 已保存提示词");
  await prompt(page).fill("登出失败也要保留的草稿");
  await page.getByRole("button", { name: `${account.email} 的账号菜单` }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("menuitem", { name: "登出", exact: true }).click();
  await expect(page.getByText("登出失败:登出服务不可用")).toBeVisible();
  await expect(page).toHaveURL(/\/agents\?id=review-a$/);
  await expect(page.getByText("已登出", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "搜索页面与会话" }).click();
  await page.getByPlaceholder("搜索页面…").fill("全部运行");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("option", { name: "全部运行" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page).toHaveURL(/\/agents\?id=review-a$/);
});

test("AI 编辑请求完成前换对象，不跳到旧对象的设计会话", async ({ page }) => {
  await fixture(page);
  let pending: Route | undefined;
  await page.route("**/api/agents/design", (route) => {
    pending = route;
  });
  await page.goto("/agents?id=review-a");
  await expect(prompt(page)).toHaveValue("审查智能体 A 已保存提示词");
  await page.getByRole("button", { name: "AI 编辑", exact: true }).click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.getByRole("link", { name: "审查智能体 B", exact: true }).click();
  await expect(prompt(page)).toHaveValue("审查智能体 B 已保存提示词");
  await pending?.fulfill({ json: { sessionId: "late-design-session" } });
  await expect(page.getByRole("button", { name: "AI 编辑", exact: true })).toBeEnabled();
  await expect(page).toHaveURL(/\/agents\?id=review-b$/);
});

test("恢复版本期间换对象，迟到回调不重新打开旧对象", async ({ page }) => {
  await fixture(page);
  let pending: Route | undefined;
  await page.route("**/api/agents/review-a/versions", (route) =>
    route.fulfill({ json: { versions: [{ version: 1, name: "A", createdAt: 1 }] } }),
  );
  await page.route("**/api/agents/review-a/versions/1/restore", (route) => {
    pending = route;
  });
  await page.goto("/agents?id=review-a");
  await expect(prompt(page)).toHaveValue("审查智能体 A 已保存提示词");
  await page.getByRole("tab", { name: "发布与分享", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "载入草稿", exact: true }).click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.getByRole("link", { name: "审查智能体 B", exact: true }).click();
  await expect(prompt(page)).toHaveValue("审查智能体 B 已保存提示词");
  await pending?.fulfill({ json: { ok: true } });
  await page.waitForTimeout(150);
  await expect(page).toHaveURL(/\/agents\?id=review-b$/);
  await expect(prompt(page)).toHaveValue("审查智能体 B 已保存提示词");
});

test("恢复版本等待期间输入的新修改不会被覆盖", async ({ page }) => {
  await fixture(page);
  let pending: Route | undefined;
  await page.route("**/api/agents/review-a/versions", (route) =>
    route.fulfill({ json: { versions: [{ version: 1, name: "A", createdAt: 1 }] } }),
  );
  await page.route("**/api/agents/review-a/versions/1/restore", (route) => {
    pending = route;
  });
  await page.goto("/agents?id=review-a");
  await expect(prompt(page)).toHaveValue("审查智能体 A 已保存提示词");
  await page.getByRole("tab", { name: "发布与分享", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "载入草稿", exact: true }).click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.getByRole("tab", { name: "配置", exact: true }).click();
  await prompt(page).fill("恢复请求之后输入的修改");
  await pending?.fulfill({ json: { ok: true } });
  await expect(page.getByText("服务端草稿已恢复，当前表单的新修改仍保留。")).toBeVisible();
  await expect(prompt(page)).toHaveValue("恢复请求之后输入的修改");
  await expect(save(page)).toBeEnabled();
});

test("旧会话追加消息的迟到重发结果不能发送到新会话", async ({ page }) => {
  await fixture(page);
  let pending: Route | undefined;
  const runPosts: string[] = [];
  await page.route("**/api/sessions/review-default-session/history", (route) =>
    route.fulfill({
      json: {
        turns: [{ runId: "active-default-run", prompt: "模拟运行", events: [], running: true }],
        activeRunId: "active-default-run",
      },
    }),
  );
  await page.route("**/api/sessions/*/events?*", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: 'data: {"kind":"status","status":"running"}\n\n',
    }),
  );
  await page.route("**/api/sessions/*/approvals", (route) =>
    route.fulfill({ json: { pending: [], grants: [] } }),
  );
  await page.route("**/api/sessions/review-default-session/steer", (route) => {
    pending = route;
  });
  await page.route("**/api/sessions/*/run", (route) => {
    runPosts.push(route.request().url());
    return route.fulfill({ status: 400, json: { error: "禁止真实运行" } });
  });
  await page.goto("/?session=review-default-session");
  const input = page.locator("[data-conversation-shell] textarea");
  await expect(input).toHaveAttribute("placeholder", /运行中/);
  await input.fill("只给旧会话的追加消息");
  await input.press("Enter");
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.getByRole("button", { name: "展开 审查智能体 A 的会话" }).click();
  await page.getByRole("link", { name: "A 历史会话", exact: true }).click();
  await expect(input).toHaveAttribute("placeholder", "说点什么,或输入 /");
  await pending?.fulfill({ status: 409, json: { code: "not_accepting" } });
  await page.waitForTimeout(150);
  expect(runPosts).toEqual([]);
  await expect(page.getByLabel("排队中的消息")).toHaveCount(0);
});

test("移动端审批与输入区均可见，切会话时立即清除旧审批", async ({ page }, testInfo) => {
  await fixture(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.route("**/api/sessions/review-default-session/approvals", (route) =>
    route.fulfill({
      json: {
        pending: [
          {
            id: "mobile-approval",
            toolName: "Bash",
            summary: "写入本会话的工作目录",
            reason: "需要人工确认",
            createdAt: Date.now(),
            expiresAt: Date.now() + 600_000,
          },
        ],
        grants: [],
      },
    }),
  );
  let nextPoll: Route | undefined;
  await page.route("**/api/sessions/review-a-session/approvals", (route) => {
    nextPoll = route;
  });
  await page.goto("/?session=review-default-session");
  const approve = page
    .locator("[data-slot=card]")
    .getByRole("button", { name: "批准", exact: true });
  await expect(approve).toBeInViewport();
  const input = page.locator("[data-conversation-shell] textarea");
  await expect(input).toBeInViewport();
  await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "添加附件", exact: true })).toBeVisible();
  const cardBox = await page.locator("[data-slot=card]").boundingBox();
  const inputBox = await input.boundingBox();
  expect(cardBox && inputBox && cardBox.y + cardBox.height <= inputBox.y).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("approval-mobile.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "打开智能体树" }).click();
  const drawer = page.getByRole("dialog", { name: "智能体与会话" });
  await drawer.getByRole("button", { name: "展开 审查智能体 A 的会话" }).click();
  await drawer.getByRole("link", { name: "A 历史会话", exact: true }).click();
  await expect.poll(() => Boolean(nextPoll)).toBe(true);
  await expect(page.getByText("写入本会话的工作目录", { exact: false })).toHaveCount(0);
  await nextPoll?.fulfill({ json: { pending: [], grants: [] } });
});

for (const next of ["另一会话", "同会话下一轮", "原运行"] as const) {
  test(`停止响应仅影响原运行，当前为${next}`, async ({ page }) => {
    await fixture(page);
    let cancellation: Route | undefined;
    let stream: Route | undefined;
    await page.route("**/api/sessions/*/approvals", (route) =>
      route.fulfill({ json: { pending: [], grants: [] } }),
    );
    await page.route("**/api/sessions/review-default-session/history", (route) =>
      route.fulfill({
        json: {
          turns: [{ runId: "old-run", prompt: "原来的运行", events: [], running: true }],
          activeRunId: "old-run",
        },
      }),
    );
    await page.route("**/api/sessions/review-a-session/history", (route) =>
      route.fulfill({
        json: {
          turns: [{ runId: "new-run", prompt: "后来的运行", events: [], running: true }],
          activeRunId: "new-run",
        },
      }),
    );
    await page.route("**/api/sessions/*/events?*", (route) => {
      if (route.request().url().includes("runId=old-run")) {
        stream = route;
        return;
      }
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'data: {"kind":"status","status":"running"}\n\n',
      });
    });
    await page.route("**/api/sessions/review-default-session/cancel", (route) => {
      cancellation = route;
    });
    await page.route("**/api/sessions/review-default-session/run", (route) =>
      route.fulfill({
        contentType: "text/event-stream",
        headers: { "X-Run-Id": "new-run" },
        body: 'data: {"kind":"status","status":"running"}\n\n',
      }),
    );
    await page.goto("/?session=review-default-session");
    await expect(page.getByRole("button", { name: "停止运行", exact: true })).toBeVisible();
    await expect.poll(() => Boolean(stream)).toBe(true);
    await page.getByRole("button", { name: "停止运行", exact: true }).click();
    await expect.poll(() => Boolean(cancellation)).toBe(true);
    if (next === "另一会话") {
      await page.getByRole("button", { name: "展开 审查智能体 A 的会话" }).click();
      await page.getByRole("link", { name: "A 历史会话", exact: true }).click();
      await expect(page.getByRole("heading", { level: 1, name: "审查智能体 A" })).toBeVisible();
    } else if (next === "同会话下一轮") {
      await stream?.fulfill({
        contentType: "text/event-stream",
        body: 'data: {"kind":"result","runId":"old-run","status":"success","summary":"原运行已结束"}\n\n',
      });
      await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeVisible();
      await page.getByRole("textbox", { name: "消息", exact: true }).fill("后来的运行");
      await page.getByRole("textbox", { name: "消息", exact: true }).press("Enter");
    }
    await expect(page.getByRole("button", { name: "停止运行", exact: true })).toBeVisible();
    await cancellation?.fulfill({ json: { cancelled: ["old-run"], note: "旧请求停止完成" } });
    await page.waitForTimeout(150);
    if (next === "原运行") {
      await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeVisible();
      await expect(page.getByText("旧请求停止完成", { exact: false })).toBeVisible();
    } else {
      await expect(page.getByRole("button", { name: "停止运行", exact: true })).toBeVisible();
      await expect(page.getByText("旧请求停止完成", { exact: false })).toHaveCount(0);
    }
  });
}

test("准备 AI 编辑时继续输入，跳转前需确认且可以保留新修改", async ({ page }) => {
  await fixture(page);
  let pending: Route | undefined;
  await page.route("**/api/agents/design", (route) => {
    pending = route;
  });
  await page.goto("/agents?id=review-a");
  await expect(prompt(page)).toHaveValue("审查智能体 A 已保存提示词");
  await page.getByRole("button", { name: "AI 编辑", exact: true }).click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await prompt(page).fill("请求发出后输入的新修改");
  let confirmations = 0;
  page.on("dialog", async (dialog) => {
    confirmations++;
    await dialog.dismiss();
  });
  await pending?.fulfill({ json: { sessionId: "prepared-design" } });
  await expect.poll(() => confirmations).toBe(1);
  await expect(page).toHaveURL(/\/agents\?id=review-a$/);
  await expect(prompt(page)).toHaveValue("请求发出后输入的新修改");
  await expect(save(page)).toBeEnabled();
});

for (const [status, outcome] of [
  [202, "dropped"],
  [409, "dropped"],
  [202, "delivered"],
] as const) {
  test(`追加消息 ${outcome} 事件先于 HTTP ${status} 返回时，正确处理且不重复补发`, async ({
    page,
  }) => {
    await fixture(page);
    let stream: Route | undefined;
    let steer: Route | undefined;
    const prompts: string[] = [];
    await page.route("**/api/sessions/*/approvals", (route) =>
      route.fulfill({ json: { pending: [], grants: [] } }),
    );
    await page.route("**/api/sessions/review-default-session/history", (route) =>
      route.fulfill({
        json: {
          turns: [{ runId: "steer-run", prompt: "模拟执行", events: [], running: true }],
          activeRunId: "steer-run",
        },
      }),
    );
    await page.route("**/api/sessions/*/events?*", (route) => {
      stream = route;
    });
    await page.route("**/api/sessions/review-default-session/steer", (route) => {
      steer = route;
    });
    await page.route("**/api/sessions/review-default-session/run", (route) => {
      prompts.push(route.request().postDataJSON().prompt);
      const id = `resent-${prompts.length}`;
      return route.fulfill({
        contentType: "text/event-stream",
        headers: { "X-Run-Id": id },
        body: `data: ${JSON.stringify({
          kind: "result",
          runId: id,
          status: "success",
          summary: "模拟完成",
        })}\n\n`,
      });
    });
    await page.goto("/?session=review-default-session");
    const input = page.getByRole("textbox", { name: "消息", exact: true });
    await expect(input).toHaveAttribute("placeholder", /运行中/);
    await expect.poll(() => Boolean(stream)).toBe(true);
    await input.fill("必须补发的消息");
    await input.press("Enter");
    await expect.poll(() => Boolean(steer)).toBe(true);
    const id = steer?.request().postDataJSON().id;
    await stream?.fulfill({
      contentType: "text/event-stream",
      body: [
        { kind: "steer", id, text: "必须补发的消息", outcome },
        { kind: "result", runId: "steer-run", status: "success", summary: "原运行完成" },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
    });
    await expect(input).toHaveAttribute("placeholder", "说点什么,或输入 /");
    await steer?.fulfill({
      status,
      json: status === 202 ? { outcome: "pending" } : { code: "dropped" },
    });
    const expected = outcome === "dropped" ? ["必须补发的消息"] : [];
    await expect.poll(() => prompts).toEqual(expected);
    await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeVisible();
    // A later render must not re-arm the already handled dropped event.
    await input.fill("下一条正常输入");
    await input.press("Enter");
    await expect.poll(() => prompts.length).toBe(expected.length + 1);
    await page.waitForTimeout(150);
    expect(prompts).toEqual([...expected, "下一条正常输入"]);
  });
}
