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
  const body = (await res.json()) as { agent?: { id: string } };
  if (!body.agent?.id) throw new Error("创建智能体未返回 ID");
  return body.agent.id;
}

type AgentList = {
  agents?: {
    id: string;
    config?: { skillPackages?: { name: string; files: Record<string, string> }[] };
  }[];
};

function getSkillFiles(body: AgentList, agentId: string, skillName: string) {
  return body.agents
    ?.find((a) => a.id === agentId)
    ?.config?.skillPackages?.find((s) => s.name === skillName)?.files;
}

test.describe("技能包多文件管理", () => {
  test("API 预创建 → 页面加载 → 编辑脚本 → 保存 → API 验证", async ({ page, context }) => {
    await register(context, "skill-api");
    const agentId = await createAgent(context, "PW 技能 API");

    await context.request.post(`${BASE}/api/agents`, {
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

    await page.goto(`${BASE}/agents?id=${agentId}`);
    await page.getByRole("tab", { name: "能力", exact: true }).click();
    await expect(page.getByLabel("技能名")).toHaveValue("render-anim", { timeout: 10_000 });

    // 验证所有文件可见
    await expect(page.getByText("SKILL.md").first()).toBeVisible();
    const scriptRow = page.locator("button", { hasText: "scripts/render.py" }).first();
    await expect(scriptRow).toBeVisible();
    await expect(page.locator("button", { hasText: "templates/base.py" }).first()).toBeVisible();

    // 展开 SKILL.md
    await page.getByText("SKILL.md").first().click();
    await expect(page.locator('textarea[placeholder*="SKILL.md"]')).toHaveValue(/步骤/);

    // 展开脚本并编辑
    await scriptRow.click();
    const scriptTa = page.locator('textarea[placeholder="scripts/render.py 内容"]');
    await expect(scriptTa).toHaveValue(/python3/);
    await scriptTa.clear();
    await scriptTa.fill("#!/usr/bin/env python3\nprint('modified')");

    // 保存
    await page.getByRole("button", { name: /保存/ }).first().click();
    await page.waitForTimeout(3000);

    // API 验证
    const body = (await (await context.request.get(`${BASE}/api/agents`)).json()) as AgentList;
    const files = getSkillFiles(body, agentId, "render-anim");
    expect(files?.["scripts/render.py"]).toContain("modified");
    expect(files?.["SKILL.md"]).toContain("步骤");
    expect(files?.["templates/base.py"]).toContain("class Base");
  });

  test("新增文件 → 写内容 → 保存 → 重新打开 → 删除文件 → 再保存", async ({ page, context }) => {
    await register(context, "skill-crud");
    const agentId = await createAgent(context, "PW 技能增删");

    await page.goto(`${BASE}/agents?id=${agentId}`);
    await page.getByRole("tab", { name: "能力", exact: true }).click();
    await page.waitForTimeout(2000);

    // 添加技能
    await page.getByRole("button", { name: "添加" }).first().click();
    await page.getByLabel("技能名").fill("data-tool");
    await page.getByLabel("技能描述").fill("数据处理工具");

    // 编辑 SKILL.md
    await page.getByText("SKILL.md").first().click();
    await page
      .locator('textarea[placeholder*="SKILL.md"]')
      .fill("# 数据处理\n运行 scripts/proc.sh");

    // 添加附属文件
    await page.getByRole("button", { name: "添加文件" }).click();
    await page.getByPlaceholder("文件路径").fill("scripts/proc.sh");
    await page.getByRole("button", { name: "确定" }).click();

    // 写脚本内容（添加后自动展开）
    await page
      .locator('textarea[placeholder="scripts/proc.sh 内容"]')
      .fill("#!/bin/bash\necho done");

    // 再添加一个文件
    await page.getByRole("button", { name: "添加文件" }).click();
    await page.getByPlaceholder("文件路径").fill("config.json");
    await page.getByRole("button", { name: "确定" }).click();
    await page.locator('textarea[placeholder="config.json 内容"]').fill('{"key":"value"}');

    // 保存
    await page.getByRole("button", { name: /保存/ }).first().click();
    await page.waitForTimeout(3000);

    // API 验证 3 个文件都在
    let body = (await (await context.request.get(`${BASE}/api/agents`)).json()) as AgentList;
    let files = getSkillFiles(body, agentId, "data-tool");
    expect(files?.["SKILL.md"]).toContain("数据处理");
    expect(files?.["scripts/proc.sh"]).toContain("echo done");
    expect(files?.["config.json"]).toContain("key");

    // 重新打开页面
    await page.reload();
    await page.waitForTimeout(3000);
    await page.getByRole("tab", { name: "能力", exact: true }).click();
    await expect(page.getByLabel("技能名")).toHaveValue("data-tool", { timeout: 10_000 });

    // 验证文件列表
    await expect(page.locator("button", { hasText: "scripts/proc.sh" }).first()).toBeVisible();
    await expect(page.locator("button", { hasText: "config.json" }).first()).toBeVisible();

    // 删除 config.json
    await page.getByLabel("删除 config.json").click();

    // config.json 应该消失
    await expect(page.locator("button", { hasText: "config.json" })).not.toBeVisible();

    // 再保存
    await page.getByRole("button", { name: /保存/ }).first().click();
    await page.waitForTimeout(3000);

    // API 验证 config.json 被删除、其他文件保留
    body = (await (await context.request.get(`${BASE}/api/agents`)).json()) as AgentList;
    files = getSkillFiles(body, agentId, "data-tool");
    expect(files?.["SKILL.md"]).toContain("数据处理");
    expect(files?.["scripts/proc.sh"]).toContain("echo done");
    expect(files?.["config.json"]).toBeUndefined();
  });
});
