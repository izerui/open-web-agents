import type { AgentConfig } from "./config";
import { DESIGN_EXECUTOR_ID } from "./system-agent";

/** 兼容历史设计记录的实体 ID;平台执行配置由代码维护,不开放业务智能体管理。 */
export const ARCHITECT_AGENT_ID = DESIGN_EXECUTOR_ID;
export const BUNDLE_README = "# 智能体包\n\n历史设计文件。请从平台的 AI 编辑入口继续维护。\n";

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
- mcpServers:MCP 服务定义数组,每项有 name、type(http/stdio)、url 或 command/args/env。
  凭证必须使用 {{变量名}} 引用(如 url:"https://api.example.com?token={{API_KEY}}")。
  需要密钥时同步在 parameters.variables 中声明对应的变量定义(secret:true)。
- skillRefs、mcpRefs:引用已有资源的 ref 列表。与 skillPackages/mcpServers 共存,同名时 inline 优先。

边界:
1. 不安装依赖、不启动 MCP 服务、不执行外部业务工具、不部署服务。
2. 凭证(API Key、密码、Token)必须使用 {{变量名}} 引用,绝不硬编码。
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
