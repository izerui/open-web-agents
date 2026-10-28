// 知识库上传与检索测试的界面验收:选择多个文件 → 逐个显示结果(成功的字数、失败的原因)→
// 文档出现在列表 → 检索测试显示命中片段与实际注入文本;没命中给出说明。
import { type BrowserContext, expect, test } from "@playwright/test";
import { docx, pdf } from "../src/lib/modules/knowledge/adapters/__tests__/fixtures/make";

const BASE = process.env.OWA_E2E_BASE_URL ?? "http://localhost:5678";

async function register(ctx: BrowserContext) {
  const res = await ctx.request.post(`${BASE}/api/auth`, {
    data: {
      action: "register",
      email: `pw-kbup-${Date.now()}@example.test`,
      password: "e2e-password-123456",
    },
  });
  expect(res.ok()).toBeTruthy();
}

test("上传多个文件、看结果,再做检索测试", async ({ page, context }) => {
  await register(context);
  const created = await context.request.post(`${BASE}/api/agents`, {
    data: { name: "PW 资料助手", config: { systemPrompt: "按资料回答", model: "sonnet" } },
  });
  const agentId = ((await created.json()) as { agent: { id: string } }).agent.id;
  await page.goto(`${BASE}/agents?id=${agentId}`);
  await page.getByRole("tab", { name: "知识", exact: true }).click();

  await page.getByLabel("上传知识库文件").setInputFiles([
    {
      name: "差旅报销制度.docx",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(docx(["住宿标准每晚不超过 450 元"])),
    },
    {
      name: "安全手册.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(pdf("实验室安全守则", { cjk: true })),
    },
    {
      name: "旧文件.xls",
      mimeType: "application/octet-stream",
      buffer: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]),
    },
  ]);
  const results = page.getByTestId("upload-results");
  await expect(results).toContainText("差旅报销制度.docx — Word", { timeout: 30_000 });
  await expect(results).toContainText("安全手册.pdf — PDF 1 页");
  await expect(results).toContainText("旧文件.xls — 这是旧版 Office 格式");
  await expect(page.getByRole("button", { name: "差旅报销制度", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "安全手册", exact: true })).toBeVisible();

  const search = page.getByTestId("knowledge-search");
  await search.getByLabel("检索测试问题").fill("住宿标准是多少");
  await search.getByRole("button", { name: "检索" }).click();
  await expect(search.getByTestId("knowledge-hit").first()).toContainText("差旅报销制度");
  await search.getByRole("button", { name: "查看实际注入给模型的文本" }).click();
  await expect(search.locator("pre")).toContainText("450 元");

  await search.getByLabel("检索测试问题").fill("zzqqxx");
  await search.getByRole("button", { name: "检索" }).click();
  await expect(search.getByTestId("knowledge-search-empty")).toBeVisible();
});
