// 对话页第二轮还原度修复(chat N1–N4、F15、F26、explore-studio N4)的界面核对。
// 接口全部用 page.route 模拟,不真跑模型、不写库。登录用设计核对账号(整组只登录一次)。
// 截图目录:OWA_SHOT_DIR(默认 docs/design-demos/coze-v3/implementation/fidelity/chat/after2/)。
import path from "node:path";
import { type Page, type Route, expect, test } from "@playwright/test";

const OUT =
  process.env.OWA_SHOT_DIR ??
  path.join(process.cwd(), "docs/design-demos/coze-v3/implementation/fidelity/chat/after2");
const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(OUT, `${name}.png`), animations: "disabled" });

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const UNTITLED_AT = NOW - 2 * 86_400_000;

const agents = [
  {
    id: "expense-reviewer",
    name: "差旅报销初审",
    canWrite: true,
    canRead: true,
    ownerId: "me",
    config: { model: "sonnet" },
    publishedVersion: 3,
  },
  {
    id: "market-agent",
    name: "合同条款检查",
    canWrite: false,
    canRead: false,
    ownerId: "someone",
    config: { model: "sonnet" },
    publishedVersion: 2,
    avgCredits: 3.48291,
  },
];

const sessions = [
  {
    id: "s1",
    agentId: "expense-reviewer",
    workspaceDir: "/ws/s1",
    title: "11 月差旅报销初审",
    createdAt: NOW - 3_600_000,
    lastActiveAt: NOW - 600_000,
    runCount: 2,
    activeRuns: 0,
  },
  {
    id: "s3",
    agentId: "expense-reviewer",
    workspaceDir: "/ws/s3",
    createdAt: UNTITLED_AT,
    lastActiveAt: UNTITLED_AT,
    runCount: 1,
    activeRuns: 0,
  },
];

const QUESTION = "外币发票按哪天的汇率换算？";
const baseTurns = [
  {
    runId: "r1",
    prompt: "帮我初审 11 月的差旅报销",
    running: false,
    startedAt: iso(NOW - 3_000_000),
    events: [
      {
        kind: "text",
        text: "初审写在 [初审结果.md](初审结果.md)。制度原文见 [官网](https://www.example.com/policy/travel)。",
      },
      { kind: "result", status: "success" },
    ],
  },
];
/** 最后一轮的提问没等到回答(超时):卡片上可以「作为新消息发送」 */
const unansweredTurn = {
  runId: "r2",
  prompt: "外币发票怎么算？",
  running: false,
  startedAt: iso(NOW - 600_000),
  events: [
    {
      kind: "question",
      toolUseId: "q2",
      questions: [{ question: QUESTION, options: [{ label: "开票日" }, { label: "入账日" }] }],
    },
    { kind: "tool_result", toolUseId: "q2", text: "The user did not answer the questions." },
    { kind: "text", text: "先按开票日算了，你可以再告诉我。" },
    { kind: "result", status: "success" },
  ],
};
const runningTurn = {
  runId: "r3",
  prompt: "把 1015 和 1021 提交审批",
  running: true,
  startedAt: iso(NOW - 30_000),
  events: [
    {
      kind: "tool_use",
      tool: "erp-finance.submit",
      toolUseId: "t9",
      input: { invoices: "1015,1021" },
    },
  ],
};

interface Opts {
  history?: unknown;
  approvals?: () => unknown;
}

async function mock(page: Page, o: Opts = {}) {
  await page.route("**/api/agents", (r) => r.fulfill({ json: { agents } }));
  await page.route("**/api/agents/*/variables*", (r) =>
    r.fulfill({ json: { variables: [], values: {}, filled: false } }),
  );
  await page.route("**/api/sessions?*", (r) =>
    r.fulfill({ json: { sessions: r.request().url().includes("archived=1") ? [] : sessions } }),
  );
  await page.route("**/api/sessions/*/history", (r) =>
    r.fulfill({ json: o.history ?? { turns: [...baseTurns, unansweredTurn] } }),
  );
  await page.route("**/api/sessions/*/approvals*", (r) =>
    r.request().method() === "GET"
      ? r.fulfill({ json: o.approvals?.() ?? { pending: [], grants: [] } })
      : r.fulfill({ json: { ok: true } }),
  );
  await page.route("**/api/sessions/*/events?*", () => {
    // 一直挂着:运行中
  });
  await page.route("**/api/sessions/*/branch", (r) => r.fulfill({ json: { runId: "r9" } }));
  await page.route(/\/api\/sessions\/[^/?]+$/, (r) =>
    r.fulfill({ json: { session: { id: "s1", model: "sonnet" } } }),
  );
  await page.route("**/api/sessions/*/files?*", (r: Route) => {
    const url = new URL(r.request().url());
    if (url.searchParams.get("dir") !== null) return r.fulfill({ json: { nodes: [] } });
    return r.fulfill({ status: 404, json: { error: "not found" } });
  });
}

const approvalPending = () => ({
  pending: [
    {
      id: "ap1",
      toolName: "erp-finance.submit",
      summary: "提交 2 张审批单",
      reason: "会写入 ERP",
      scopes: [{ key: "erp", label: "erp-finance.submit" }],
      createdAt: NOW,
      expiresAt: Date.now() + 500_000,
    },
  ],
  grants: [],
});

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ mode: "serial" });

let page: Page;
test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const res = await page.request.post("/api/auth", {
    data: {
      action: "login",
      email: process.env.OWA_REVIEW_EMAIL ?? "design-review@example.test",
      password: process.env.OWA_REVIEW_PASSWORD ?? "design-review-123",
    },
  });
  expect(res.ok(), `登录失败: ${res.status()}`).toBeTruthy();
  await page.addInitScript(() => localStorage.setItem("owa.chat.right", "none"));
});
test.afterAll(async () => {
  await page.close();
});
test.afterEach(async () => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("N1:外链弹中文确认框，画在页面最上层", async () => {
  await mock(page);
  await page.goto("/chat?session=s1");
  await page.getByRole("button", { name: "官网", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "打开外部链接？" });
  await expect(dialog).toContainText("www.example.com");
  await expect(dialog.getByRole("button", { name: "打开链接" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "复制链接" })).toBeVisible();
  await expect(page.getByText("Open external link?")).toHaveCount(0);
  // Dialog 挂在 body 下(portal),不在对话流里
  expect(await dialog.evaluate((el) => el.closest("main") === null)).toBe(true);
  await shot(page, "N1-external-link-dialog");
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(dialog).toHaveCount(0);
});

test("N3 + explore-studio N4:作为新消息发送带上问题；没标题的会话写「新对话 · 时间」", async () => {
  await mock(page);
  await page.goto("/chat?session=s1");
  const nav = page.getByRole("navigation", { name: "会话列表" });
  await expect(nav.getByText(/^新对话 · \d{2}-\d{2} \d{2}:\d{2}$/)).toBeVisible();
  await expect(nav.getByText("s3", { exact: true })).toHaveCount(0);
  const card = page.locator('[data-question-tool="q2"]');
  await card.getByText("开票日", { exact: true }).click();
  await card.getByRole("button", { name: "作为新消息发送" }).click();
  await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue(
    `关于「${QUESTION}」：按开票日。`,
  );
  await shot(page, "N3-send-as-new-with-question");
});

test("F15:新会话弹层显示市场单价", async () => {
  await mock(page);
  await page.goto("/chat?session=s1");
  await page.getByRole("button", { name: "新会话" }).first().click();
  const dialog = page.getByRole("dialog", { name: "新会话" });
  await expect(dialog).toContainText("市场，跑已发布 v2，约 3.5 积分/次");
  await shot(page, "F15-new-dialog-market-price");
  await page.keyboard.press("Escape");
});

test("N4:重跑给提示", async () => {
  await mock(page);
  await page.goto("/chat?session=s1");
  await page.getByRole("button", { name: "重跑", exact: true }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "重跑", exact: true }).click();
  await expect(page.getByText("已回到会话开头，正在重跑")).toBeVisible();
  await shot(page, "N4-rerun-toast");
});

test("N2 + N4:等确认的通知在右上角，底部提示避开输入框；取消排队、离开运行中的会话有提示", async () => {
  await mock(page, {
    history: { turns: [...baseTurns, runningTurn], activeRunId: "r3" },
    approvals: approvalPending,
  });
  await page.goto("/chat?session=s1");
  const note = page.getByText("差旅报销初审在等你确认");
  await expect(note).toBeVisible();
  const noteBox = await note.boundingBox();
  expect(noteBox && noteBox.y < 160 && noteBox.x > 900).toBe(true);
  await expect(page.getByText("erp-finance.submit，提交 2 张审批单")).toBeVisible();

  // 排队 → 底部提示应在输入区上方
  const box = page.getByRole("textbox", { name: "消息", exact: true });
  await box.fill("顺便把 1018 退回");
  await box.press("Enter");
  const queuedToast = page.getByText(/这条消息已排队/);
  await expect(queuedToast).toBeVisible();
  await page.waitForTimeout(600);
  const toastBox = await queuedToast.boundingBox();
  const cardBox = await page.getByRole("region", { name: "待你确认" }).boundingBox();
  expect(toastBox && cardBox && toastBox.y + toastBox.height <= cardBox.y).toBe(true);
  await shot(page, "N2-approval-corner-and-toast-above-composer");

  // 取消排队
  await page.getByRole("button", { name: "取消这条排队消息" }).click();
  await expect(page.getByText("已取消排队：顺便把 1018 退回")).toBeVisible();
  await shot(page, "N4-unqueue-toast");

  // 「稍后」只收起右上角通知,审批卡还在
  await page.getByRole("button", { name: "稍后" }).click();
  await expect(note).toHaveCount(0);
  await expect(page.getByRole("region", { name: "待你确认" })).toBeVisible();

  // 离开运行中的会话
  await page
    .getByRole("navigation", { name: "会话列表" })
    .getByText(/^新对话 · /)
    .click();
  await expect(page.getByText("「11 月差旅报销初审」还在后台运行")).toBeVisible();
  await shot(page, "N4-left-running-toast");
});

test("N2:375 宽下底部提示也在输入框上方", async () => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mock(page);
  await page.goto("/chat?session=s1");
  const box = page.getByRole("textbox", { name: "消息", exact: true });
  await box.fill("/stop");
  await box.press("Enter");
  const t = page.getByText("当前没有在运行的任务");
  await expect(t).toBeVisible();
  await page.waitForTimeout(600);
  const tb = await t.boundingBox();
  const bb = await box.boundingBox();
  expect(tb && bb && tb.y + tb.height <= bb.y).toBe(true);
  await shot(page, "N2-mobile-toast-above-composer");
  await page.setViewportSize({ width: 1440, height: 900 });
});
