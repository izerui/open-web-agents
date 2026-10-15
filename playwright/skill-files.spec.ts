// 技能包多文件管理浏览器验收

import { type BrowserContext, expect, test } from "@playwright/test";

const BASE = process.env.OWA_E2E_BASE_URL ?? "http://localhost:5678";

async function register(ctx: BrowserContext, tag: string) {
  const res = await ctx.request.post(`${BASE}/api/auth`, {
    data: {
      action: "register",
      email: `pw-${tag}-${Date.now()}@example.test`,
      password: "e2e-password-123456",
    },
  });
  expect(res.ok(), `注册失败: ${res.status()}`).toBeTruthy();
}

async function createAgent(ctx: BrowserContext, name: string) {
  const res = await ctx.request.post(`${BASE}/api/agents`, {
    data: { name, config: { systemPrompt: "测试", model: "sonnet" } },
  });
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { agent?: { id: string } }).agent!.id;
}

test.describe("技能包多文件管理", () => {
  test("通过 API 创建含多文件技能 → 页面加载 → 验证文件完整可编辑", async ({
    page,
    context,
  }) => {
    await register(context, "skill-api");
    const agentId = await createAgent(context, "PW 技能 API");

    // 通过 POST 保存含多文件技能的智能体（构建器用 POST）
    const putRes = await context.request.post(`${BASE}/api/agents`, {
      data: {
        id: agentId,
        name: "PW 技能 API",
        config: {
          systemPrompt: "测试",
          model: "sonnet",
          skillPackages: [
            {
              name: "render-anim",
              description: "需要把推导做成动画时使用",
              files: {
                "SKILL.md": "# 步骤\n1. 读取主题\n2. 运行 scripts/render.py",
                "scripts/render.py": "#!/usr/bin/env python3\nprint('hello')",
                "templates/base.py": "class Base: pass",
              },
            },
          ],
        },
      },
    });
    expect(putRes.ok(), `保存失败: ${putRes.status()}`).toBeTruthy();

    // 打开构建器页面
    await page.goto(`${BASE}/agents?id=${agentId}`);
    await page.waitForTimeout(3000);

    // 验证技能名加载
    await expect(page.getByLabel("技能名")).toHaveValue("render-anim", { timeout: 10_000 });

    // 验证 SKILL.md 文件按钮可见
    const skillMdBtn = page.getByText("SKILL.md").first();
    await expect(skillMdBtn).toBeVisible();

    // 展开 SKILL.md 查看内容
    await skillMdBtn.click();
    const skillMdTextarea = page.locator('textarea[placeholder*="SKILL.md"]');
    await expect(skillMdTextarea).toHaveValue(/步骤/, { timeout: 3_000 });

    // 验证附属文件可见
    const renderBtn = page.getByRole("button", { name: /scripts\/render\.py/ }).first();
    await expect(renderBtn).toBeVisible();
    const templateBtn = page.getByRole("button", { name: /templates\/base\.py/ }).first();
    await expect(templateBtn).toBeVisible();

    // 展开脚本查看内容
    await renderBtn.click();
    const scriptTextarea = page.locator('textarea[placeholder="scripts/render.py 内容"]');
    await expect(scriptTextarea).toHaveValue(/python3/, { timeout: 3_000 });

    // 编辑脚本内容
    await scriptTextarea.clear();
    await scriptTextarea.fill("#!/usr/bin/env python3\nprint('modified')");

    // 保存
    await page.getByRole("button", { name: /保存/ }).first().click();
    await page.waitForTimeout(3000);

    // API 验证修改后的内容
    const listRes = await context.request.get(`${BASE}/api/agents`);
    const agents = ((await listRes.json()) as { agents?: { id: string; config?: { skillPackages?: { name: string; files: Record<string, string> }[] } }[] }).agents;
    const saved = agents?.find((a) => a.id === agentId)?.config?.skillPackages?.find((s) => s.name === "render-anim");
    expect(saved, "技能包应该保存").toBeTruthy();
    expect(saved!.files["scripts/render.py"]).toContain("modified");
    expect(saved!.files["SKILL.md"]).toContain("步骤");
    expect(saved!.files["templates/base.py"]).toContain("class Base");
  });
});
