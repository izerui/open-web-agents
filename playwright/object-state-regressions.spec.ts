import { randomUUID } from "node:crypto";
import { type BrowserContext, type Page, type Route, expect, test } from "@playwright/test";

const account = {
  email: `pw-object-state-${randomUUID().slice(0, 8)}@example.test`,
  password: "e2e-password-123456",
};
let authCookies: Parameters<BrowserContext["addCookies"]>[0] = [];
/** 构建页(编排 › 档案):提示词一节默认展开;没有保存按钮,停顿约 800ms 自动保存 */
const prompt = (page: Page) => page.getByRole("textbox", { name: "系统提示词", exact: true });
/** 「名称」在「名称与头像」一节里,默认收起(新建时九节都收起),先展开 */
async function nameField(page: Page) {
  const head = page.locator('[data-sec="identity"] > button');
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  return page.getByRole("textbox", { name: "名称", exact: true });
}
/** 页头的保存状态文字 */
const saveStatus = (page: Page, text: string | RegExp) => page.getByText(text);
const stages = (page: Page) => page.getByRole("navigation", { name: "构建阶段" });
const stageButton = (page: Page, label: string) =>
  stages(page).getByRole("button", { name: new RegExp(`^${label}`) });
/** 构建页左栏「我的智能体」里的一行(可访问名 = 名字 + 状态行) */
const railAgent = (page: Page, name: string) =>
  page.locator("aside").getByRole("button", { name: new RegExp(`^${name}`) });
/** 构建页页头里的智能体名称 */
const buildTitle = (page: Page, name: string) =>
  page
    .locator("header")
    .filter({ has: page.getByRole("link", { name: "返回工作室" }) })
    .getByText(name, { exact: true });
/** 顶栏搜索(⌘K)里选一个页面 */
async function openSearch(page: Page, query: string) {
  await page.getByRole("button", { name: "搜索页面、智能体与会话" }).click();
  await page.getByPlaceholder("搜索页面、智能体、会话…").fill(query);
}
const designer = (page: Page) => page.getByRole("region", { name: "智能体设计器", exact: true });
/** 对话页(coze-v3):对话头里的智能体名链接、左栏会话列表里的会话行 */
const chatAgent = (page: Page, name: string) =>
  page.getByRole("region", { name: "当前对话" }).getByRole("link", { name, exact: true });
const sessionRow = (scope: Page | ReturnType<Page["getByRole"]>, title: string) =>
  scope.getByRole("link", { name: new RegExp(`^${title}`) });
const composer = (page: Page) => page.getByRole("textbox", { name: "消息", exact: true });

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
  await page.route("**/api/sessions?*", (route) =>
    route.fulfill({
      json: { sessions: route.request().url().includes("archived=1") ? [] : sessions },
    }),
  );
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

// 构建页左栏「我的智能体」在 1280px 以下隐藏;用宽屏保证左栏可点(移动端用例自己改视口)
test.use({ viewport: { width: 1440, height: 900 } });

test("保存 A 的迟到响应不能改写 B 的对象身份或表单", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/agents/review-a");
  await expect(prompt(page)).toHaveValue("审查智能体 A 已保存提示词");
  state.hold();
  await prompt(page).fill("A 保存快照");
  // 停顿后自动保存发出,被挡住
  await expect.poll(() => state.submitted.length).toBe(1);
  // 左栏切换会先等自动保存落盘;用搜索直接跳到 B,让 A 的保存响应在 B 打开之后才回来
  page.on("dialog", (dialog) => dialog.accept());
  await openSearch(page, "审查智能体 B");
  await page.getByRole("option", { name: /审查智能体 B/ }).click();
  await expect(prompt(page)).toHaveValue("审查智能体 B 已保存提示词");
  await state.release();
  await page.waitForTimeout(150);
  // A 的迟到响应不算 B 的保存:B 仍是「没改过」的状态
  await expect(saveStatus(page, "改动会自动保存")).toBeVisible();
  await expect(page).toHaveURL(/\/agents\/review-b$/);
  await expect(buildTitle(page, "审查智能体 B")).toBeVisible();
  await expect(prompt(page)).toHaveValue("审查智能体 B 已保存提示词");
  await prompt(page).fill("B 修改");
  await expect.poll(() => state.submitted.length).toBe(2);
  expect(state.submitted[1]).toMatchObject({
    id: "review-b",
    config: { systemPrompt: "B 修改" },
  });
});

test("保存期间继续编辑同一对象，新内容仍会保存；左栏同步改名", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/agents/review-a");
  await expect(prompt(page)).toHaveValue("审查智能体 A 已保存提示词");
  state.hold();
  await (await nameField(page)).fill("A 新名称");
  await expect.poll(() => state.submitted.length).toBe(1);
  await prompt(page).fill("保存发出后的新编辑");
  await state.release();
  await expect(prompt(page)).toHaveValue("保存发出后的新编辑");
  await expect(railAgent(page, "A 新名称")).toBeVisible();
  // 保存进行中又改了:这次存完自动再存一次,带上新内容
  await expect.poll(() => state.submitted.length).toBe(2);
  expect(state.submitted[1]).toMatchObject({
    id: "review-a",
    name: "A 新名称",
    config: { systemPrompt: "保存发出后的新编辑" },
  });
  await expect(saveStatus(page, /草稿自动保存于/)).toBeVisible();
});

test("搜索跳转可以取消，离开后迟到的保存不改变页面", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/agents/review-a");
  await expect(prompt(page)).toHaveValue("审查智能体 A 已保存提示词");
  // 挡住自动保存,让草稿保持「没落盘」
  state.hold();
  await prompt(page).fill("仍未保存");
  await expect.poll(() => state.submitted.length).toBe(1);
  await openSearch(page, "运行记录");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("option", { name: "运行记录", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page).toHaveURL(/\/agents\/review-a$/);
  await page.keyboard.press("Escape");
  await expect(prompt(page)).toHaveValue("仍未保存");
  await (await nameField(page)).fill("离开后保存的 A");
  await openSearch(page, "运行记录");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("option", { name: "运行记录", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "运行记录" })).toBeVisible();
  await state.release();
  await page.waitForTimeout(150);
  // 原先断言的全站对象树改名已不存在(构建页左栏只在构建页里),这里只验证迟到的保存不把页面带回去
  await expect(page.getByRole("heading", { level: 1, name: "运行记录" })).toBeVisible();
  await expect(page).toHaveURL(/\/developer\/runs$/);
});

test("新建态（智能体设计器）里没存下的档案也能取消搜索跳转", async ({ page }) => {
  // 原「AI 编辑」独立页面已并入构建页;它的新建态 /agents/new?designer= 里档案没填全时暂停保存,离开同样要确认
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
  await page.goto("/agents/new?designer=review-design");
  await (await nameField(page)).fill("未保存的设计");
  await expect(saveStatus(page, /暂停保存：提示词为空/)).toBeVisible();
  await openSearch(page, "运行记录");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("option", { name: "运行记录", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page).toHaveURL(/\/agents\/new\?designer=review-design$/);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("option", { name: "运行记录", exact: true }).click();
  await expect(page).toHaveURL(/\/developer\/runs$/);
});

test("会话列表跨智能体切换会话；新会话先选智能体，再清掉地址里的旧会话", async ({ page }) => {
  await fixture(page);
  await page.goto("/chat?session=review-default-session");
  await expect(chatAgent(page, "通用智能体")).toBeVisible();
  await sessionRow(page.getByRole("navigation", { name: "会话列表" }), "A 历史会话").click();
  await expect(chatAgent(page, "审查智能体 A")).toHaveAttribute("href", "/agents/review-a");
  await expect(page).toHaveURL(/session=review-a-session/);
  await chatAgent(page, "审查智能体 A").click();
  await expect(prompt(page)).toHaveValue("审查智能体 A 已保存提示词");
  await page.goBack();
  await expect(composer(page)).toBeEnabled();
  await page.getByRole("button", { name: "新会话", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "新会话" });
  await picker.getByRole("button", { name: /审查智能体 B/ }).click();
  await expect(picker).toBeHidden();
  await expect(chatAgent(page, "审查智能体 B")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "新会话" })).toBeVisible();
  await expect(page).toHaveURL(/\/chat\?agent=review-b$/);
});

test("无效或空对象链接禁止发送，用户显式选择后恢复；有效会话优先", async ({ page }) => {
  await fixture(page);
  for (const id of ["missing-review-agent", ""]) {
    await page.goto(`/chat?agent=${id}`);
    await expect(
      page.getByRole("heading", {
        level: 2,
        name: id ? "找不到指定的智能体，或你没有访问权限。" : "链接缺少智能体 ID。",
      }),
    ).toBeVisible();
    await expect(composer(page)).toBeDisabled();
    await expect(stages(page)).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/chat\\?agent=${id}$`));
    await page.getByRole("button", { name: "新会话", exact: true }).click();
    await page
      .getByRole("dialog", { name: "新会话" })
      .getByRole("button", { name: /审查智能体 A/ })
      .click();
    await expect(composer(page)).toBeEnabled();
    await expect(chatAgent(page, "审查智能体 A")).toBeVisible();
  }
  await page.goto("/chat?agent=missing-review-agent&session=review-a-session");
  await expect(chatAgent(page, "审查智能体 A")).toBeVisible();
  await expect(composer(page)).toBeEnabled();
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
  await page.goto("/chat?session=review-default-session");
  await expect.poll(() => Boolean(pending)).toBe(true);
  await sessionRow(page.getByRole("navigation", { name: "会话列表" }), "A 历史会话").click();
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
  await expect(chatAgent(page, "审查智能体 A")).toBeVisible();
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
  await page.route("**/api/sessions?*", (route) => route.fulfill({ json: { sessions: [] } }));
  await page.route("**/api/sessions/*/run", (route) => {
    runPosts.push(route.request().url());
    return route.fulfill({ status: 400, json: { error: "测试禁止模型调用" } });
  });
  await page.goto("/chat?agent=review-a");
  const input = composer(page);
  await expect(input).toBeEnabled();
  await input.fill("仅测试迟到响应");
  await input.press("Enter");
  await expect.poll(() => Boolean(pending)).toBe(true);
  await chatAgent(page, "审查智能体 A").click();
  await expect(prompt(page)).toHaveValue("审查智能体 A 已保存提示词");
  await pending?.fulfill({ json: { session: { id: "late-session", agentId: "review-a" } } });
  await page.waitForTimeout(150);
  await expect(page).toHaveURL(/\/agents\/review-a$/);
  expect(runPosts).toEqual([]);
});

test("删除 A 期间切到 B，删除完成不清空 B 编辑器", async ({ page }) => {
  await fixture(page);
  let pending: Route | undefined;
  await page.route("**/api/agents/review-a", (route) => {
    pending = route;
  });
  // 先在 B,再从左栏进 A:删除确认弹层在请求完成前一直挡着页面,换对象用浏览器后退回到 B
  await page.goto("/agents/review-b");
  await expect(prompt(page)).toHaveValue("审查智能体 B 已保存提示词");
  await railAgent(page, "审查智能体 A").click();
  await expect(page).toHaveURL(/\/agents\/review-a$/);
  await expect(prompt(page)).toHaveValue("审查智能体 A 已保存提示词");
  await page.getByRole("button", { name: "更多操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "删除智能体", exact: true }).click();
  // 删除要先输入智能体 ID
  await page
    .getByRole("dialog")
    .getByLabel(/输入智能体 ID/)
    .fill("review-a");
  await page.getByRole("dialog").getByRole("button", { name: "删除智能体", exact: true }).click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.goBack();
  await expect(page).toHaveURL(/\/agents\/review-b$/);
  await expect(prompt(page)).toHaveValue("审查智能体 B 已保存提示词");
  await pending?.fulfill({ json: { ok: true } });
  await page.waitForTimeout(150);
  await expect(page).toHaveURL(/\/agents\/review-b$/);
  await expect(prompt(page)).toHaveValue("审查智能体 B 已保存提示词");
});

test("登出失败保留当前页面与账号，不显示成功", async ({ page }) => {
  const state = await fixture(page);
  await page.route("**/api/auth", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({ status: 503, json: { error: "登出服务不可用" } });
    } else await route.continue();
  });
  await page.goto("/agents/review-a");
  await expect(prompt(page)).toHaveValue("审查智能体 A 已保存提示词");
  // 挡住自动保存,让草稿保持「没落盘」,登出与跳转前都要确认
  state.hold();
  await prompt(page).fill("登出失败也要保留的草稿");
  await expect.poll(() => state.submitted.length).toBe(1);
  await page.getByRole("button", { name: "账号菜单", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("menuitem", { name: "登出", exact: true }).click();
  await expect(page.getByText("登出失败:登出服务不可用")).toBeVisible();
  await expect(page).toHaveURL(/\/agents\/review-a$/);
  await expect(page.getByText("已登出", { exact: true })).toHaveCount(0);
  await expect(prompt(page)).toHaveValue("登出失败也要保留的草稿");
  await openSearch(page, "运行记录");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("option", { name: "运行记录", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page).toHaveURL(/\/agents\/review-a$/);
});

test("新建设计请求完成前换对象，不把旧对象的设计会话写进地址", async ({ page }) => {
  // 原「AI 编辑」按钮换成构建页里智能体设计器的「新建设计」;会话建好后只改地址里的 ?designer=,不再跳页
  await fixture(page);
  let pending: Route | undefined;
  await page.route("**/api/agents/design", (route) => {
    if (route.request().method() === "POST") {
      pending = route;
      return;
    }
    return route.fulfill({ json: { sessions: [] } });
  });
  await page.goto("/agents/review-a");
  await expect(prompt(page)).toHaveValue("审查智能体 A 已保存提示词");
  await designer(page).getByRole("button", { name: "新建设计", exact: true }).click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await railAgent(page, "审查智能体 B").click();
  await expect(prompt(page)).toHaveValue("审查智能体 B 已保存提示词");
  await pending?.fulfill({ json: { sessionId: "late-design-session" } });
  await page.waitForTimeout(150);
  await expect(designer(page).getByRole("button", { name: "新建设计", exact: true })).toBeEnabled();
  await expect(page).toHaveURL(/\/agents\/review-b$/);
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
  // 先在 B,再从左栏进 A:载入草稿的确认弹层在请求完成前一直挡着页面,换对象用浏览器后退回到 B
  await page.goto("/agents/review-b");
  await expect(prompt(page)).toHaveValue("审查智能体 B 已保存提示词");
  await railAgent(page, "审查智能体 A").click();
  await expect(prompt(page)).toHaveValue("审查智能体 A 已保存提示词");
  await stageButton(page, "发布").click();
  await page.getByRole("button", { name: "载入草稿", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "载入草稿", exact: true }).click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.goBack();
  await expect(page).toHaveURL(/\/agents\/review-b$/);
  await expect(prompt(page)).toHaveValue("审查智能体 B 已保存提示词");
  await pending?.fulfill({ json: { ok: true } });
  await page.waitForTimeout(150);
  await expect(page).toHaveURL(/\/agents\/review-b$/);
  await expect(prompt(page)).toHaveValue("审查智能体 B 已保存提示词");
});

// 「恢复版本等待期间输入的新修改不会被覆盖」已删除:载入草稿改为应用内确认弹层,请求完成前弹层不可关闭并挡住档案,等待期间无法再改草稿

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
  await page.goto("/chat?session=review-default-session");
  const input = composer(page);
  await expect(input).toHaveAttribute("placeholder", /运行中/);
  await input.fill("只给旧会话的追加消息");
  await input.press("Enter");
  await expect.poll(() => Boolean(pending)).toBe(true);
  await sessionRow(page.getByRole("navigation", { name: "会话列表" }), "A 历史会话").click();
  await expect(input).toHaveAttribute("placeholder", "说点什么，或输入 /");
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
  await page.goto("/chat?session=review-default-session");
  const approval = page.getByRole("region", { name: "待你确认" });
  const approve = approval.getByRole("button", { name: "批准", exact: true });
  await expect(approve).toBeInViewport();
  const input = composer(page);
  await expect(input).toBeInViewport();
  await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "添加图片或文件", exact: true })).toBeVisible();
  const cardBox = await approval.boundingBox();
  const inputBox = await input.boundingBox();
  expect(cardBox && inputBox && cardBox.y + cardBox.height <= inputBox.y).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("approval-mobile.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "会话列表", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "会话列表" });
  await sessionRow(drawer, "A 历史会话").click();
  await expect(drawer).toBeHidden();
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
    await page.goto("/chat?session=review-default-session");
    await expect(page.getByRole("button", { name: "停止运行", exact: true })).toBeVisible();
    await expect.poll(() => Boolean(stream)).toBe(true);
    await page.getByRole("button", { name: "停止运行", exact: true }).click();
    await expect.poll(() => Boolean(cancellation)).toBe(true);
    if (next === "另一会话") {
      await sessionRow(page.getByRole("navigation", { name: "会话列表" }), "A 历史会话").click();
      await expect(chatAgent(page, "审查智能体 A")).toBeVisible();
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

test("新建设计期间继续输入，新修改保留并自动保存", async ({ page }) => {
  // 原「AI 编辑」要跳到设计页,所以跳转前确认;设计器并入构建页后不再跳页,也就没有确认框,只验证新修改不丢
  const state = await fixture(page);
  let pending: Route | undefined;
  await page.route("**/api/agents/design", (route) => {
    if (route.request().method() === "POST") {
      pending = route;
      return;
    }
    return route.fulfill({ json: { sessions: [] } });
  });
  await page.goto("/agents/review-a");
  await expect(prompt(page)).toHaveValue("审查智能体 A 已保存提示词");
  await designer(page).getByRole("button", { name: "新建设计", exact: true }).click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await prompt(page).fill("请求发出后输入的新修改");
  let confirmations = 0;
  page.on("dialog", async (dialog) => {
    confirmations++;
    await dialog.dismiss();
  });
  await pending?.fulfill({ json: { sessionId: "prepared-design" } });
  await expect(page).toHaveURL(/\/agents\/review-a\?designer=prepared-design$/);
  await expect(prompt(page)).toHaveValue("请求发出后输入的新修改");
  await expect
    .poll(() => state.submitted.at(-1))
    .toMatchObject({
      id: "review-a",
      config: { systemPrompt: "请求发出后输入的新修改" },
    });
  expect(confirmations).toBe(0);
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
    await page.goto("/chat?session=review-default-session");
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
    await expect(input).toHaveAttribute("placeholder", "说点什么，或输入 /");
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
