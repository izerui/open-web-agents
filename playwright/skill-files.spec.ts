// 技能包多文件管理浏览器验收(构建页编排 › 档案的「能力」节;改动停顿后自动保存,没有保存按钮)

import { type BrowserContext, type Page, expect, test } from "@playwright/test";

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

/** 展开档案的「能力」节(默认收起) */
async function openAbility(page: Page) {
  const section = page.locator('[data-sec="ability"]');
  await section.locator(":scope > button").click();
  return section;
}

/** 等改动自动保存落盘:页头保存状态从「保存中…」回到「草稿自动保存于 hh:mm:ss」 */
async function autosaved(page: Page) {
  await expect(page.getByText(/草稿自动保存于 \d{2}:\d{2}:\d{2}/)).toBeVisible({
    timeout: 10_000,
  });
}

/** 附属文件那一行的「编辑 / 收起」按钮(和「删除 <路径>」在同一行) */
function fileToggle(page: Page, path: string) {
  return page
    .getByRole("button", { name: `删除 ${path}`, exact: true })
    .locator("xpath=..")
    .getByRole("button", { name: /^(编辑|收起)$/ });
}

test.describe("技能包多文件管理", () => {
  test("API 预创建 → 页面加载 → 编辑脚本 → 自动保存 → API 验证", async ({ page, context }) => {
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

    await page.goto(`${BASE}/agents/${agentId}`);
    const ability = await openAbility(page);
    // 已有名字的技能包默认收起,点「编辑」展开
    await ability.getByRole("button", { name: "编辑", exact: true }).click();
    await expect(page.getByLabel("技能名", { exact: true })).toHaveValue("render-anim", {
      timeout: 10_000,
    });

    // 验证所有文件可见
    await expect(page.getByRole("button", { name: "SKILL.md", exact: true })).toBeVisible();
    await expect(page.getByText("scripts/render.py", { exact: true })).toBeVisible();
    await expect(page.getByText("templates/base.py", { exact: true })).toBeVisible();

    // 展开 SKILL.md
    await page.getByRole("button", { name: "SKILL.md", exact: true }).click();
    await expect(page.getByLabel("SKILL.md 正文", { exact: true })).toHaveValue(/步骤/);

    // 展开脚本并编辑
    await fileToggle(page, "scripts/render.py").click();
    const scriptTa = page.getByLabel("scripts/render.py 内容", { exact: true });
    await expect(scriptTa).toHaveValue(/python3/);
    await scriptTa.clear();
    await scriptTa.fill("#!/usr/bin/env python3\nprint('modified')");

    // 停顿后自动保存
    await autosaved(page);

    // API 验证
    const body = (await (await context.request.get(`${BASE}/api/agents`)).json()) as AgentList;
    const files = getSkillFiles(body, agentId, "render-anim");
    expect(files?.["scripts/render.py"]).toContain("modified");
    expect(files?.["SKILL.md"]).toContain("步骤");
    expect(files?.["templates/base.py"]).toContain("class Base");
  });

  test("新增文件 → 写内容 → 自动保存 → 重新打开 → 删除文件 → 再自动保存", async ({
    page,
    context,
  }) => {
    await register(context, "skill-crud");
    const agentId = await createAgent(context, "PW 技能增删");

    await page.goto(`${BASE}/agents/${agentId}`);
    const ability = await openAbility(page);

    // 添加技能(新加的技能包没有名字,默认展开)
    await ability.getByRole("button", { name: "添加技能包", exact: true }).click();
    await page.getByLabel("技能名", { exact: true }).fill("data-tool");
    await page.getByLabel("技能描述", { exact: true }).fill("数据处理工具");

    // 编辑 SKILL.md
    await page.getByRole("button", { name: "SKILL.md", exact: true }).click();
    await page
      .getByLabel("SKILL.md 正文", { exact: true })
      .fill("# 数据处理\n运行 scripts/proc.sh");

    // 添加附属文件
    await page.getByLabel("新文件路径", { exact: true }).fill("scripts/proc.sh");
    await page.getByRole("button", { name: "添加文件", exact: true }).click();

    // 写脚本内容（添加后自动展开）
    await page.getByLabel("scripts/proc.sh 内容", { exact: true }).fill("#!/bin/bash\necho done");

    // 再添加一个文件
    await page.getByLabel("新文件路径", { exact: true }).fill("config.json");
    await page.getByRole("button", { name: "添加文件", exact: true }).click();
    await page.getByLabel("config.json 内容", { exact: true }).fill('{"key":"value"}');

    // 停顿后自动保存
    await autosaved(page);

    // API 验证 3 个文件都在
    let body = (await (await context.request.get(`${BASE}/api/agents`)).json()) as AgentList;
    let files = getSkillFiles(body, agentId, "data-tool");
    expect(files?.["SKILL.md"]).toContain("数据处理");
    expect(files?.["scripts/proc.sh"]).toContain("echo done");
    expect(files?.["config.json"]).toContain("key");

    // 重新打开页面
    await page.reload();
    const reopened = await openAbility(page);
    await reopened.getByRole("button", { name: "编辑", exact: true }).click();
    await expect(page.getByLabel("技能名", { exact: true })).toHaveValue("data-tool", {
      timeout: 10_000,
    });

    // 验证文件列表
    await expect(page.getByText("scripts/proc.sh", { exact: true })).toBeVisible();
    await expect(page.getByText("config.json", { exact: true })).toBeVisible();

    // 删除 config.json
    await page.getByRole("button", { name: "删除 config.json", exact: true }).click();

    // config.json 应该消失
    await expect(page.getByText("config.json", { exact: true })).toHaveCount(0);

    // 停顿后再次自动保存
    await autosaved(page);

    // API 验证 config.json 被删除、其他文件保留
    body = (await (await context.request.get(`${BASE}/api/agents`)).json()) as AgentList;
    files = getSkillFiles(body, agentId, "data-tool");
    expect(files?.["SKILL.md"]).toContain("数据处理");
    expect(files?.["scripts/proc.sh"]).toContain("echo done");
    expect(files?.["config.json"]).toBeUndefined();
  });
});
