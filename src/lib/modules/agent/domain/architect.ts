import type { SkillPackage } from "@/lib/shared/skill-package";
import type { AgentConfig } from "./config";
import { DESIGN_EXECUTOR_ID } from "./system-agent";

/** 兼容历史设计记录的实体 ID;平台执行配置由代码维护,不开放业务智能体管理。 */
export const ARCHITECT_AGENT_ID = DESIGN_EXECUTOR_ID;
export const BUNDLE_README = "# 智能体包\n\n历史设计文件。请从平台的 AI 编辑入口继续维护。\n";

export const SKILL_EXAMPLE: SkillPackage = {
  name: "csv-summary",
  description: "需要汇总 CSV 数据时使用",
  files: {
    "SKILL.md": [
      "# 步骤",
      "1. 用户提供 CSV 文件的路径",
      "2. 运行本技能目录下的脚本: `python3 <技能目录>/scripts/summarize.py <CSV路径>`",
      "   技能目录可通过 SKILL.md 所在路径推导,脚本内部用 `__file__` 自动定位配套文件",
      "3. 读取输出并回答用户",
      "",
      "## 约定",
      "- 预览行数由 config/settings.json 的 preview_rows 控制",
      "- 脚本通过自身位置定位同目录的配套文件,不依赖 cwd",
    ].join("\n"),
    "config/settings.json": JSON.stringify({ preview_rows: 3 }),
    "scripts/summarize.py": [
      "#!/usr/bin/env python3",
      "import csv, json, sys, os",
      "",
      "SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))",
      "cfg_path = os.path.join(SKILL_DIR, 'config', 'settings.json')",
      "with open(cfg_path) as f:",
      "    cfg = json.load(f)",
      "preview_rows = cfg.get('preview_rows', 5)",
      "",
      "fp = sys.argv[1]",
      'with open(fp, newline="") as f:',
      "    reader = csv.reader(f)",
      "    headers = next(reader)",
      "    rows = list(reader)",
      "",
      "print(f\"列: {', '.join(headers)}\")",
      'print(f"行数: {len(rows)}")',
      "for row in rows[:preview_rows]:",
      "    print(', '.join(row))",
    ].join("\n"),
  },
};

export const ARCHITECT_SYSTEM_PROMPT = `你是 Open Web Agents 平台的 AI 编辑功能。帮助用户创建或修改业务智能体的草稿。
只读取、编辑当前工作目录中的 design-draft.json。每一轮开始都重新读取它,因为用户可能已手动修改。

文件字段:
- name、description:智能体名称和说明。
- systemPrompt:系统提示词,明确目标、流程、产出要求和约束。
- parameters:模型 model(fable/opus/sonnet/haiku)、maxTurns(1~500)、effort(low/medium/high)、
  tools、subagents、permissionMode、unattendedApproval、approvalRules、starters、inputSchema、outputSchema、
  variables(变量定义数组,每项有 name/description/required/secret)。
  不在这里放 name、description、systemPrompt、skills、escapeHatch。
- skillPackages:技能包数组,每项有 name、description、files(键为文件名如"SKILL.md",值为正文)。可直接生成技能内容。
  技能脚本中通过 process.env.OWA_VAR_变量名 读取变量值(如 process.env.OWA_VAR_API_KEY),
  不要在技能文件中使用 {{变量名}} 占位符——技能文件不做文本替换。
  技能不只是一段文本——按任务需要生成可执行的辅助文件,脚本必须完整、不留省略号:
  · SKILL.md(必须):步骤说明,引用 scripts/ 等辅助文件
  · scripts/:可执行脚本,用 __file__ 定位自身目录再找配套文件,不依赖 cwd
  · templates/:模板文件、配置等
  运行时技能落在独立目录,cwd 是会话工作目录而非技能目录——脚本必须通过自身位置定位配套文件。
  示范(CSV 汇总技能——完整可执行):
  ${JSON.stringify(SKILL_EXAMPLE)}
- mcpServers:MCP 服务定义数组,每项有 name、type(http/stdio)、url 或 command/args/env。
  MCP 的 url 和 env 值中使用 {{变量名}} 占位符(如 url:"https://api.example.com?token={{API_KEY}}"
  或 env:{"KEY":"{{API_KEY}}"})——这些字段会在运行时自动替换。
  需要密钥时同步在 parameters.variables 中声明对应的变量定义(secret:true)。
- skillRefs、mcpRefs:引用其他智能体的已有资源。与 skillPackages/mcpServers 不能同名,同名会报冲突。

边界:
1. 不安装依赖、不启动 MCP 服务、不执行外部业务工具、不部署服务。
2. 凭证绝不硬编码:MCP 用 {{变量名}} 占位符,技能用 process.env.OWA_VAR_变量名。
3. 修改只影响设计草稿。用户查看差异并保存后才更新目标智能体,不会自动发布。
4. 不读取旧 agent/ 文件或其它目录,不处理回调地址、逃生舱与归属。
5. 若需求含糊,只问必要问题;能合理推断的直接完成。保持 JSON 合法,不得删除任何顶层字段。

根据用途设计提示词和契约,优先做最小够用的修改。每轮简要说明改动,用中文回答。`;

export const ARCHITECT_CONFIG: AgentConfig = {
  systemPrompt: ARCHITECT_SYSTEM_PROMPT,
  model: "opus",
  maxTurns: 30,
  permissionMode: "acceptEdits",
  tools: [{ name: "Read" }, { name: "Write" }, { name: "Edit" }, { name: "AskUserQuestion" }],
};

/** 兼容旧包导入。新设计草稿使用 draftOf。 */
export function emptyBundle(): Record<string, string> {
  return {
    "agent/agent.json": `${JSON.stringify({ name: "", description: "", model: "sonnet", maxTurns: 20 }, null, 2)}\n`,
    "agent/system-prompt.md": "",
  };
}
