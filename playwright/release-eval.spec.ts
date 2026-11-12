// 评测与发布关联的界面验收(构建页的评测 / 发布阶段):没有用例 / 没评测时上线清单里「发布为 vN」不可用并说明原因;
// 在评测阶段对草稿跑评测,全部通过后上线清单随即显示通过、可以发布;发布后版本列表带出该版的评测结果;
// 在编排里改了草稿(自动保存),上线清单随即提示配置已变化、不能发布,评测历史不再标"= 当前草稿"。
// 需要专用测试库(给测试账号入账:评测会真正发起运行)。
import { expect, test } from "@playwright/test";
import { fundTestAccount } from "../e2e/client";

const BASE = process.env.OWA_E2E_BASE_URL ?? "http://localhost:5678";
const DB = process.env.OWA_E2E_DATABASE_URL;

test.describe("评测与发布", () => {
  test.skip(!DB || !/test/i.test(new URL(DB).pathname), "需要专用测试库来给账号入账");

  test("评测全部通过才能发布;改了草稿提示过期", async ({ page, context }) => {
    const reg = await context.request.post(`${BASE}/api/auth`, {
      data: {
        action: "register",
        email: `pw-releval-${Date.now()}@example.test`,
        password: "e2e-password-123456",
      },
    });
    const { user } = (await reg.json()) as { user: { id: string } };
    await fundTestAccount(user.id, 100_000n);
    const created = await context.request.post(`${BASE}/api/agents`, {
      data: { name: "PW 门槛", config: { systemPrompt: "原始提示词", model: "sonnet" } },
    });
    const agentId = ((await created.json()) as { agent: { id: string } }).agent.id;
    page.on("dialog", (d) => void d.accept());
    const stage = (label: string) =>
      page
        .getByRole("navigation", { name: "构建阶段" })
        .getByRole("button", { name: new RegExp(`^${label}`) });
    const evalStatus = page.getByTestId("eval-run-match").first();

    // 上线清单(发布阶段):评测项不满足时「发布为 v1」不可用,并在评测项里说明原因
    await page.goto(`${BASE}/agents/${agentId}?stage=publish`);
    await expect(page.getByRole("heading", { level: 2, name: "上线清单" })).toBeVisible();
    const publish = page.getByRole("button", { name: "发布为 v1" });
    await expect(page.getByText("还没有用例，至少需要 1 个")).toBeVisible({ timeout: 15_000 });
    await expect(stage("评测")).toContainText("无用例");
    await expect(publish).toBeDisabled();

    // 加一个用例(此环境模型不可用,运行必然失败:"期望失败"的用例稳定通过)
    await context.request.post(`${BASE}/api/agents/${agentId}/evals/cases`, {
      data: { name: "期望失败", input: "x", assertions: { expectSuccess: false } },
    });
    await page.reload();
    await expect(page.getByText("1 个用例还没对当前草稿运行")).toBeVisible({ timeout: 15_000 });
    await expect(publish).toBeDisabled();

    // 评测阶段对当前草稿跑全部用例(先确认花费)→ 页头徽标与上线清单随即重读
    await stage("评测").click();
    await expect(page.getByLabel("评测哪个版本")).toHaveValue("draft");
    await page.getByRole("button", { name: "运行全部 1 个用例" }).click();
    await page
      .getByRole("dialog", { name: "运行评测" })
      .getByRole("button", { name: "开始运行" })
      .click();
    await expect(stage("评测")).toContainText("1/1 通过", { timeout: 30_000 });
    await expect(evalStatus).toContainText("= 当前草稿");
    await stage("发布").click();
    await expect(page.getByText("评测 1/1 通过", { exact: true })).toBeVisible();
    await expect(publish).toBeEnabled();
    await publish.click();
    await expect(page.getByTestId("version-eval").first()).toHaveText("评测 1/1 通过", {
      timeout: 15_000,
    });
    await stage("评测").click();
    await expect(evalStatus).toContainText("= v1");

    // 编排里改草稿(停顿后自动保存,没有保存按钮):上线清单提示配置已变化,不能发布
    await stage("编排").click();
    await page.getByRole("textbox", { name: "系统提示词", exact: true }).fill("改过的提示词");
    await expect(page.getByText(/草稿自动保存于/)).toBeVisible({ timeout: 15_000 });
    await stage("发布").click();
    await expect(page.getByText(/配置变了，上次评测（1\/1）不代表当前草稿/)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("button", { name: "发布为 v2" })).toBeDisabled();
    await stage("评测").click();
    await expect(evalStatus).not.toContainText("= 当前草稿");
  });
});
