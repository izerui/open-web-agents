// 对话页还原度修复(chat F1–F27)的界面核对:接口全部用 page.route 模拟,不真跑模型。
// 截图存到 docs/design-demos/coze-v3/implementation/fidelity/chat/after/。
// 登录用设计核对账号(OWA_REVIEW_EMAIL / OWA_REVIEW_PASSWORD,默认 design-review@example.test)。
import path from "node:path";
import { type Page, type Route, expect, test } from "@playwright/test";

const OUT = path.join(
  process.cwd(),
  "docs/design-demos/coze-v3/implementation/fidelity/chat/after",
);
const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(OUT, `${name}.png`), animations: "disabled" });

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

const agents = [
  {
    id: "expense-reviewer",
    name: "差旅报销初审",
    canWrite: true,
    canRead: true,
    ownerId: "me",
    config: { model: "sonnet", starters: ["帮我初审 11 月的差旅报销"] },
    publishedVersion: 3,
  },
  {
    id: "shared-agent",
    name: "合同条款检查",
    canWrite: false,
    canRead: true,
    ownerId: "someone",
    config: { model: "sonnet" },
    publishedVersion: 2,
  },
];

const sessions = [
  {
    id: "s1",
    agentId: "expense-reviewer",
    workspaceDir: "/ws/s1",
    model: "sonnet",
    title: "11 月差旅报销初审",
    createdAt: NOW - 3_600_000,
    lastActiveAt: NOW - 600_000,
    runCount: 3,
    activeRuns: 0,
    workspacePurgedAt: NOW - 86_400_000,
  },
  {
    id: "s2",
    agentId: "expense-reviewer",
    workspaceDir: "/ws/s2",
    title: "外币发票汇率",
    createdAt: NOW - 7_200_000,
    lastActiveAt: NOW - 1_200_000,
    activeRuns: 1,
    pendingQuestions: 1,
    pendingApprovals: 0,
  },
];

const history = {
  turns: [
    {
      runId: "r1",
      prompt: "帮我初审 11 月的差旅报销",
      running: false,
      startedAt: iso(NOW - 3_000_000),
      events: [
        { kind: "thinking", text: "先查制度条款。" },
        {
          kind: "tool_use",
          tool: "erp_lookup",
          toolUseId: "t1",
          input: { dept: "财务部", month: 11 },
        },
        { kind: "tool_result", toolUseId: "t1", text: "12 张发票" },
        {
          kind: "question",
          toolUseId: "q1",
          questions: [
            {
              question: "外币发票按哪天的汇率换算？",
              options: [{ label: "开票日" }, { label: "入账日" }],
            },
          ],
        },
        {
          kind: "answer",
          toolUseId: "q1",
          answers: [{ question: "外币发票按哪天的汇率换算？", answer: "开票日" }],
        },
        {
          kind: "tool_result",
          toolUseId: "q1",
          text: 'The user answered: "外币发票按哪天的汇率换算？"="开票日". Read the answers',
        },
        {
          kind: "text",
          text: "已写好两个文件：[初审结果.md](初审结果.md) 和 [退回通知](invoices/退回通知-1018.md)。制度原文见 [官网](https://example.com)。",
        },
        { kind: "usage", input: 12000, output: 800 },
        { kind: "result", status: "success" },
      ],
    },
    {
      runId: "r2",
      prompt: "1021 酒店能不能按每晚算？",
      branchedFrom: "r1",
      running: false,
      startedAt: iso(NOW - 600_000),
      events: [
        { kind: "text", text: "可以，按每晚 2,700 元算，不需要走审批。" },
        { kind: "usage", input: 9000, output: 300 },
        { kind: "result", status: "success" },
      ],
    },
  ],
};

const files: Record<string, unknown[]> = {
  "": [
    { path: "invoices", name: "invoices", type: "dir", mtime: NOW - 900_000 },
    { path: "初审结果.md", name: "初审结果.md", type: "file", size: 1800, mtime: NOW - 500_000 },
    { path: "旧记录.md", name: "旧记录.md", type: "file", size: 900, mtime: NOW - 5_000_000 },
  ],
  invoices: [
    {
      path: "invoices/退回通知-1018.md",
      name: "退回通知-1018.md",
      type: "file",
      size: 300,
      mtime: NOW - 400_000,
    },
    {
      path: "invoices/1015-机票.pdf",
      name: "1015-机票.pdf",
      type: "file",
      size: 96_000,
      mtime: NOW - 5_000_000,
    },
  ],
};

const previews: Record<string, string> = {
  "初审结果.md":
    "# 初审结果\n\n| 发票 | 金额 | 结论 |\n| --- | --- | --- |\n| 1015 机票 | 6,800 元 | 需审批（超过 5,000 元） |\n| 1018 餐饮 | 680 元 | 退回（抬头不全） |",
  "invoices/退回通知-1018.md": "# 退回通知\n\n发票 1018 抬头缺少公司全称。",
};

/** 每个用例注册一个新账号(接口都用 page.route 模拟,账号只用来过登录) */
async function login(page: Page) {
  const res = await page.request.post("/api/auth", {
    data: {
      action: "register",
      email: `pw-chat-fidelity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`,
      password: "e2e-password-123456",
    },
  });
  expect(res.ok(), `注册失败: ${res.status()}`).toBeTruthy();
}

interface Opts {
  sessions?: unknown[];
  agents?: unknown[];
  history?: unknown;
  approvals?: () => unknown;
  variables?: unknown;
}

async function mock(page: Page, o: Opts = {}) {
  await page.route("**/api/agents", (r) => r.fulfill({ json: { agents: o.agents ?? agents } }));
  await page.route("**/api/agents/*/variables*", (r) =>
    r.fulfill({ json: o.variables ?? { variables: [], values: {}, filled: false } }),
  );
  await page.route("**/api/sessions?*", (r) =>
    r.fulfill({
      json: {
        sessions: r.request().url().includes("archived=1") ? [] : (o.sessions ?? sessions),
      },
    }),
  );
  await page.route("**/api/sessions/*/history", (r) => r.fulfill({ json: o.history ?? history }));
  await page.route("**/api/sessions/*/approvals*", (r) =>
    r.request().method() === "GET"
      ? r.fulfill({ json: o.approvals?.() ?? { pending: [], grants: [] } })
      : r.fulfill({ json: { ok: true } }),
  );
  await page.route(/\/api\/sessions\/[^/?]+$/, (r) =>
    r.fulfill({ json: { session: { id: "s1", model: "sonnet" } } }),
  );
  await page.route("**/api/sessions/*/files?*", (r: Route) => {
    const url = new URL(r.request().url());
    const dir = url.searchParams.get("dir");
    const file = url.searchParams.get("file");
    if (dir !== null) return r.fulfill({ json: { nodes: files[dir] ?? [] } });
    if (file !== null)
      return r.fulfill({
        json: {
          preview: {
            path: file,
            mime: "text/markdown",
            size: 100,
            text: previews[file] ?? "# 空",
            truncated: false,
          },
        },
      });
    return r.fulfill({ status: 404, json: { error: "not found" } });
  });
  await page.route("**/api/capabilities", (r) =>
    r.fulfill({
      json: {
        capabilities: [
          {
            id: "claude-sonnet",
            name: "Claude Sonnet",
            kind: "llm",
            available: true,
            group: "a",
            rates: [
              { meter: "input_token", units: "1000000", microCredits: "3000000" },
              { meter: "output_token", units: "1000000", microCredits: "15000000" },
            ],
          },
        ],
        aliases: { sonnet: "claude-sonnet" },
      },
    }),
  );
}

test.use({ viewport: { width: 1440, height: 900 } });
test.beforeEach(async ({ page }) => {
  await login(page);
  await page.addInitScript(() => localStorage.removeItem("owa.chat.right"));
});

test("F1 F6 F9 F11 F12 F21 F23 F24 F7:正常会话", async ({ page }) => {
  await mock(page);
  await page.goto("/chat?session=s1");
  // F9:首次进入默认打开工作区文件,并自动预览最新的 md
  const panel = page.getByRole("region", { name: "工作区文件" });
  await expect(panel.getByRole("heading", { name: "初审结果" })).toBeVisible();
  // F12:清理时间固定格式
  await expect(page.getByText(/工作目录已于 \d{2}-\d{2} \d{2}:\d{2}/)).toBeVisible();
  // F1:相对路径链接是按钮,不再是 [blocked]
  await expect(page.getByText("[blocked]")).toHaveCount(0);
  // F7:没打开的会话也标「等你回答」
  await expect(
    page.getByRole("navigation", { name: "会话列表" }).getByText("等你回答"),
  ).toBeVisible();
  // F21:分叉标记
  await expect(page.getByText("从会话开头分叉重跑")).toBeVisible();
  // F23:已回答显示选项,选中的标出
  await expect(page.getByTestId("question-answer").getByText("开票日")).toBeVisible();
  // F11:没有说明字段时摘要取第一个字符串参数值
  await page
    .getByRole("button", { name: /调用了 1 个工具/ })
    .first()
    .click();
  await expect(page.getByRole("list", { name: "本轮工具调用" }).getByText("财务部")).toBeVisible();
  // F24:「新」标记(最近一轮之后改过的)
  await expect(panel.getByText("新", { exact: true })).toHaveCount(1);
  await shot(page, "chat-normal");

  // F1:点对话里的子目录文件链接 → 展开目录并预览
  await page.getByRole("button", { name: "退回通知", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "退回通知" })).toBeVisible();
  await expect(panel.getByText("2 个")).toBeVisible();
  await shot(page, "chat-link-open-file");

  // F6:点目录名收起 / 展开
  await panel.getByRole("button", { name: "invoices" }).click();
  await expect(panel.getByText("1015-机票.pdf")).toBeHidden();
  await panel.getByRole("button", { name: "invoices" }).click();
  await expect(panel.getByText("1015-机票.pdf")).toBeVisible();

  // F22:重跑预估
  await page.getByRole("button", { name: "重跑", exact: true }).first().click();
  await expect(page.getByText(/预计约 [\d.]+ 积分/)).toBeVisible();
  await shot(page, "chat-rerun");
});

function runningMocks(page: Page, kind: "approval" | "ask" | "none") {
  return Promise.all([
    page.route("**/api/sessions/*/events?*", () => {
      // 一直挂着:运行中
    }),
  ]).then(() => ({
    history: {
      turns: [
        ...history.turns,
        {
          runId: "r3",
          prompt: "把 1015 和 1021 提交审批",
          running: true,
          startedAt: iso(NOW - 30_000),
          events: [
            {
              kind: "tool_use",
              tool: kind === "ask" ? "AskUserQuestion" : "erp-finance.submit",
              toolUseId: "t9",
              input: { invoices: "1015,1021", approver: "王蕾" },
            },
            ...(kind === "ask"
              ? [
                  {
                    kind: "question",
                    toolUseId: "t9",
                    questions: [
                      { question: "审批人用谁？", options: [{ label: "王蕾" }, { label: "林舟" }] },
                    ],
                  },
                ]
              : []),
          ],
        },
      ],
      activeRunId: "r3",
    },
    approvals: () => ({
      pending:
        kind === "approval"
          ? [
              {
                id: "ap1",
                toolName: "erp-finance.submit",
                summary: "提交 2 张审批单",
                reason: "会写入 ERP",
                scopes: [{ key: "erp", label: "erp-finance.submit" }],
                createdAt: NOW,
                expiresAt: Date.now() + 500_000,
              },
            ]
          : kind === "ask"
            ? [
                {
                  id: "ask1",
                  toolName: "AskUserQuestion",
                  summary: "审批人用谁？",
                  reason: "",
                  toolUseId: "t9",
                  questions: [
                    { question: "审批人用谁？", options: [{ label: "王蕾" }, { label: "林舟" }] },
                  ],
                  createdAt: NOW,
                  expiresAt: Date.now() + 500_000,
                },
              ]
            : [],
      grants: kind === "approval" ? [{ key: "fs", label: "写工作目录" }] : [],
    }),
  }));
}

test("F3 F4 F10 F25:等你确认时", async ({ page }) => {
  const m = await runningMocks(page, "approval");
  let decided = false;
  await mock(page, {
    history: m.history,
    approvals: () => (decided ? { pending: [], grants: [] } : m.approvals()),
  });
  await page.goto("/chat?session=s1");
  const card = page.getByRole("region", { name: "待你确认" });
  await expect(card).toBeVisible();
  // F25:执行详情标「等你确认」并自动选中
  await page.getByRole("button", { name: "执行详情" }).first().click();
  await expect(page.getByRole("region", { name: "调用详情" })).toBeVisible();
  await expect(page.getByLabel("工具调用", { exact: true }).getByText("等你确认")).toBeVisible();
  // F4:等确认时发消息 → 排队
  const box = page.getByRole("textbox", { name: "消息", exact: true });
  await box.fill("顺便把 1018 退回");
  await box.press("Enter");
  await expect(page.getByLabel("排队中的消息")).toContainText("顺便把 1018 退回");
  await shot(page, "chat-approval-queued");
  // F3:停止前确认,写上排队条数
  await page.getByRole("button", { name: "停止运行", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "停止这一轮？" });
  await expect(dialog).toContainText("排队中的 1 条消息不会发送");
  await shot(page, "chat-stop-confirm");
  await dialog.getByRole("button", { name: "取消" }).click();
  // F10:批准后 toast 并立即移除卡片
  decided = true;
  await card.getByRole("button", { name: "批准", exact: true }).click();
  await expect(page.getByText("已批准", { exact: true })).toBeVisible();
  await expect(card).toHaveCount(0);
  await shot(page, "chat-approved-toast");
});

test("F2 F4:等你回答时", async ({ page }) => {
  const m = await runningMocks(page, "ask");
  await mock(page, { history: m.history, approvals: m.approvals });
  await page.goto("/chat?session=s1");
  await expect(page.getByTestId("question-state").last()).toHaveText("待回答");
  await page.waitForTimeout(2000);
  // F2:卡片就在眼前,不弹常驻通知
  await expect(page.getByText("智能体在问你问题")).toHaveCount(0);
  // F4:拦下,文字留在输入框
  const box = page.getByRole("textbox", { name: "消息", exact: true });
  await box.fill("先别提交");
  await box.press("Enter");
  await expect(page.getByText("智能体在等你回答上面的提问，先回答或选择不回答")).toBeVisible();
  await expect(box).toHaveValue("先别提交");
  await shot(page, "chat-ask-blocked");
});

test("F8:375 宽审批卡收成一行", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const m = await runningMocks(page, "approval");
  await mock(page, { history: m.history, approvals: m.approvals });
  await page.goto("/chat?session=s1");
  const card = page.getByRole("region", { name: "待你确认" });
  await expect(card.getByRole("button", { name: "批准", exact: true })).toBeVisible();
  const box = await card.boundingBox();
  expect(box && box.height < 70).toBe(true);
  await shot(page, "chat-mobile-approval-collapsed");
  await card.getByRole("button", { name: "展开审批详情" }).click();
  await expect(card.getByText("本会话已授权不再询问：")).toBeVisible();
  await shot(page, "chat-mobile-approval-expanded");
});

test("F2:375 宽提问不弹通知", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const m = await runningMocks(page, "ask");
  await mock(page, { history: m.history, approvals: m.approvals });
  await page.goto("/chat?session=s1");
  await page.waitForTimeout(1500);
  await expect(page.getByText("智能体在问你问题")).toHaveCount(0);
  await shot(page, "chat-mobile-ask");
});

test("F20:追加消息等待接收", async ({ page }) => {
  const m = await runningMocks(page, "none");
  await mock(page, { history: m.history, approvals: m.approvals });
  await page.route("**/api/sessions/*/steer", (r) =>
    r.fulfill({ status: 202, json: { outcome: "pending" } }),
  );
  await page.goto("/chat?session=s1");
  const box = page.getByRole("textbox", { name: "消息", exact: true });
  await box.fill("审批人改成林舟");
  await box.press("Enter");
  await expect(page.getByText("已提交，等待智能体接收")).toBeVisible();
  await shot(page, "chat-steer-pending");
});

test("F5 F27:必填变量没填", async ({ page }) => {
  let runs = 0;
  await mock(page, {
    sessions: [],
    variables: {
      variables: [
        { name: "ERP_TOKEN", required: true, secret: true, description: "调用 ERP 用" },
        { name: "DEPT", required: false },
      ],
      values: {},
      filled: false,
    },
  });
  await page.route("**/api/sessions", (r) => {
    runs++;
    return r.fulfill({ status: 500, json: {} });
  });
  await page.goto("/chat?agent=expense-reviewer");
  // F14:新会话还没发消息,左栏有一行
  await expect(
    page
      .getByRole("navigation", { name: "会话列表" })
      .getByRole("region", { name: "今天" })
      .getByText("新会话"),
  ).toBeVisible();
  const box = page.getByRole("textbox", { name: "消息", exact: true });
  await box.fill("开始初审");
  await box.press("Enter");
  await expect(page.getByText("先填写必填变量 ERP_TOKEN")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "填写变量" })).toBeVisible();
  // 弹窗打开时输入框在无障碍树里被隐藏,直接按元素查
  await expect(page.locator('textarea[aria-label="消息"]')).toHaveValue("开始初审");
  expect(runs).toBe(0);
  await shot(page, "chat-vars-blocked");
});

test("F27:已保存的密钥占位", async ({ page }) => {
  await mock(page, {
    sessions: [],
    variables: {
      variables: [{ name: "ERP_TOKEN", required: true, secret: true }],
      values: { ERP_TOKEN: "***" },
      filled: true,
    },
  });
  await page.goto("/chat?agent=expense-reviewer");
  await page.getByRole("button", { name: "管理变量" }).click();
  await expect(page.getByPlaceholder("已保存，留空不修改")).toBeVisible();
});

test("F13:无智能体与智能体不存在", async ({ page }) => {
  await mock(page, { agents: [], sessions: [] });
  await page.goto("/chat");
  await expect(page.getByRole("heading", { name: "还没有可用的智能体" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "消息" })).toHaveCount(0);
  await shot(page, "chat-noagent");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await mock(page, { sessions: [] });
  await page.goto("/chat?agent=expense-reviewr");
  await expect(page.getByText("expense-reviewr", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "消息" })).toHaveCount(0);
  await shot(page, "chat-badagent");
});

test("F15 F16 F17:新会话弹层、斜杠菜单、附件菜单", async ({ page }) => {
  await mock(page);
  await page.goto("/chat?session=s1");
  const box = page.getByRole("textbox", { name: "消息", exact: true });
  await box.fill("/st");
  await expect(page.locator("#slash-commands")).toBeVisible();
  await box.press("Escape");
  await expect(page.locator("#slash-commands")).toHaveCount(0);
  await expect(box).toHaveValue("/st");
  await box.fill("/stop");
  await box.press("Enter");
  await expect(page.getByText("当前没有在运行的任务")).toBeVisible();
  await page.getByRole("button", { name: "添加图片或文件" }).click();
  await expect(page.getByText("单个文件不超过 10MB")).toBeVisible();
  await shot(page, "chat-attach-menu");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "新会话" }).first().click();
  const dialog = page.getByRole("dialog", { name: "新会话" });
  await expect(dialog).toContainText("「外币发票汇率」还在运行");
  await expect(dialog).toContainText("只读，跑已发布 v2");
  await shot(page, "chat-new-dialog");
});
