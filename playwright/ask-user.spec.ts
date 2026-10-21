// 提问卡片的界面验收:智能体提问后运行原地等待,卡片显示"待回答"与剩余时间;
// 点选项或自己填写 → 提交 → 同一轮继续,卡片变成"已回答"并显示回答;刷新后仍在。
// 假网关按剧本让模型调用 AskUserQuestion。需要专用测试库(临时设管理员来配提供者与模型)。

import { type BrowserContext, expect, test } from "@playwright/test";
import { startFakeGateway } from "../scripts/sdk-probe/fake-gateway.mjs";

const BASE = process.env.OWA_E2E_BASE_URL ?? "http://localhost:5678";
const DB = process.env.OWA_E2E_DATABASE_URL;

const ask = (id: string, multiSelect: boolean) => ({
  tool: {
    id,
    name: "AskUserQuestion",
    input: {
      questions: [
        {
          question: "报告用哪种格式?",
          header: "格式",
          multiSelect,
          options: [
            { label: "PDF", description: "便于打印" },
            { label: "Word", description: "便于修改" },
          ],
        },
      ],
    },
  },
});

async function asFundedAdmin(ctx: BrowserContext) {
  const res = await ctx.request.post(`${BASE}/api/auth`, {
    data: {
      action: "register",
      email: `pw-ask-${Date.now()}@example.test`,
      password: "e2e-password-123456",
    },
  });
  expect(res.ok()).toBeTruthy();
  const { user } = (await res.json()) as { user: { id: string; role: string } };
  const { createConnection } = await import("mysql2/promise");
  if (user.role !== "admin") {
    const db = await createConnection(DB as string);
    await db.execute("UPDATE users SET role = 'admin' WHERE id = ?", [user.id]);
    await db.end();
  }
  const credited = await ctx.request.post(`${BASE}/api/billing/credits`, {
    data: { accountId: user.id, credits: "1000", reason: "Playwright 提问验收" },
    headers: { "Idempotency-Key": `pw-ask-fund-${user.id}` },
  });
  expect(credited.ok()).toBeTruthy();
  return async () => {
    if (user.role === "admin") return;
    const db = await createConnection(DB as string);
    await db.execute("UPDATE users SET role = 'user' WHERE id = ?", [user.id]);
    await db.end();
  };
}

test.describe("智能体提问", () => {
  test.skip(!DB || !/test/i.test(new URL(DB).pathname), "需要专用测试库来设置管理员");

  test("运行停在提问上:多选 + 自己填写 → 提交 → 同一轮继续,卡片显示已回答;刷新后仍在", async ({
    page,
    context,
  }) => {
    const gw = await startFakeGateway([ask("toolu_pw", true), { text: "收到,按你的要求做。" }]);
    const restore = await asFundedAdmin(context);
    const api = context.request;
    const tag = Date.now() % 1_000_000;
    try {
      const p = await (
        await api.post(`${BASE}/api/admin/providers`, {
          data: {
            definition: {
              name: `PW提问-${tag}`,
              enabled: true,
              endpoints: { llm: { protocol: "anthropic", baseUrl: gw.baseUrl } },
            },
            apiKey: `sk-pw-ask-${tag}`,
          },
        })
      ).json();
      const m = await (
        await api.post(`${BASE}/api/admin/models`, {
          data: {
            expectedVersion: null,
            definition: {
              name: `PW提问模型-${tag}`,
              kind: "llm",
              modelId: `pw-ask-${tag}`,
              enabled: true,
              acceptsImages: false,
              providerId: p.provider.id,
              markupBp: 0,
              costRates: [
                { meter: "input_token", units: "1000000", microCredits: "100000000" },
                { meter: "output_token", units: "1000000", microCredits: "100000000" },
                { meter: "cache_read_token", units: "1000000", microCredits: "0" },
                { meter: "cache_write_token", units: "1000000", microCredits: "0" },
              ],
              rates: [],
            },
          },
        })
      ).json();
      const agent = await (
        await api.post(`${BASE}/api/agents`, {
          data: { name: `PW提问-${tag}`, config: { systemPrompt: "先问", model: m.model.id } },
        })
      ).json();

      await page.goto(`${BASE}/?agent=${agent.agent.id}`);
      const box = page.getByPlaceholder("说点什么,或输入 /");
      await box.fill("帮我写份报告");
      await box.press("Enter");

      const card = page.getByTestId("question-card");
      await expect(card.getByTestId("question-state")).toHaveText("待回答", { timeout: 30_000 });
      await expect(card).toContainText("剩余");
      // 运行在等:模型还没收到第二次请求
      expect(gw.turns()).toBe(1);

      await card.getByRole("button", { name: "Word" }).click();
      await card.getByLabel("其他回答:报告用哪种格式?").fill("另外要带目录");
      await card.getByRole("button", { name: "提交回答" }).click();

      await expect(card.getByTestId("question-state")).toHaveText("已回答", { timeout: 30_000 });
      await expect(card.getByTestId("question-answer")).toContainText("Word、另外要带目录");
      await expect(page.getByText("收到,按你的要求做。")).toBeVisible();
      expect(gw.turns()).toBe(2);

      // 刷新:回答从运行记录里读出,仍然显示
      await page.reload();
      const again = page.getByTestId("question-card");
      await expect(again.getByTestId("question-state")).toHaveText("已回答", { timeout: 15_000 });
      await expect(again.getByTestId("question-answer")).toContainText("Word、另外要带目录");
      // 提问的工具结果并进卡片,不再单独列出 SDK 的原文
      await expect(page.getByText("The user answered")).toHaveCount(0);
    } finally {
      gw.close();
      await restore();
    }
  });
});
