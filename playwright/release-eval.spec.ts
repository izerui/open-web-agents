// 评测与发布关联的界面验收:没有用例 / 没评测时发布按钮不可用并说明原因;在评测面板对草稿跑评测,
// 全部通过后发布面板随即显示通过、可以发布;发布后版本列表带出该版的评测结果;
// 在表单里改了草稿并保存,发布面板随即提示配置已变化、不能发布,评测历史标出"配置已变化"。
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

    await page.goto(`${BASE}/agents?id=${agentId}`);
    await page.getByRole("tab", { name: "发布与分享", exact: true }).click();
    const draftEval = page.getByTestId("draft-eval");
    const publish = page.getByRole("button", { name: "发布为 v1" });
    await expect(draftEval).toContainText("还没有评测用例", { timeout: 15_000 });
    await expect(publish).toBeDisabled();

    // 加一个用例(此环境模型不可用,运行必然失败:"期望失败"的用例稳定通过)
    await context.request.post(`${BASE}/api/agents/${agentId}/evals/cases`, {
      data: { name: "期望失败", input: "x", assertions: { expectSuccess: false } },
    });
    await page.reload();
    await expect(draftEval).toContainText("还没有评测过", { timeout: 15_000 });

    await page.getByRole("tab", { name: "评测", exact: true }).click();
    await page.getByRole("button", { name: "运行评测" }).click();
    // 评测面板跑完 → 发布面板随即重读
    await expect(draftEval).toContainText("1/1 全部通过", { timeout: 30_000 });
    await expect(publish).toBeEnabled();
    await expect(page.getByTestId("eval-run-match").first()).toContainText("= 当前草稿");
    await page.getByRole("tab", { name: "发布与分享", exact: true }).click();
    await publish.click();
    await expect(page.getByTestId("version-eval").first()).toHaveText("评测 1/1", {
      timeout: 15_000,
    });
    await expect(page.getByTestId("eval-run-match").first()).toContainText("= v1");

    // 表单里改草稿并保存:发布面板提示配置已变化,不能发布
    await page.getByRole("tab", { name: "配置", exact: true }).click();
    await page.getByPlaceholder("你是代码评审专家……").fill("改过的提示词");
    await page.getByRole("button", { name: "保存智能体" }).click();
    await expect(draftEval).toContainText("配置已变化", { timeout: 15_000 });
    await expect(draftEval).toContainText("1/1");
    await expect(page.getByRole("button", { name: "发布为 v2" })).toBeDisabled();
    await expect(page.getByTestId("eval-run-match").first()).not.toContainText("= 当前草稿");
  });
});
