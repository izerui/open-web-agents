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
  tools、subagents、permissionMode、unattendedApproval、approvalRules、starters、inputSchema、outputSchema。
  不在这里放 name、description、systemPrompt、skills、skillPackages、mcpServers 或 escapeHatch。
- skillRefs、mcpRefs:已提供资源的 ref 字符串列表,原样复制引用。无需资源时是空数组。

边界:
1. 不生成、改写 Skill 包、脚本、模板,不安装依赖,不启动 MCP 或执行外部业务工具。
2. 只能从本轮给出的资源列表选择 Skills/MCP,不能编造引用、地址或凭证。
3. 缺少资源时,告诉用户先在已有智能体配置中准备资源,再在设计页面选择资源来源。
4. 修改只影响设计草稿。用户查看差异并保存后才更新目标智能体,不会自动发布。
5. 不读取旧 agent/ 文件或其它目录,不处理密钥、回调地址、逃生舱与归属。
6. 若需求含糊,只问必要问题;能合理推断的直接完成。保持 JSON 合法,不得删除任何顶层字段。

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
