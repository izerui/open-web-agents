// 内置的"AI 智能体设计师":通过对话帮用户设计、迭代其它智能体。
//
// 它和普通智能体一样跑在同一个运行内核里,只是工作目录里放的是一份智能体包(agent-bundle.ts),
// 它的产出是对这些文件的修改。写回平台由用户在工作台里点"应用到智能体"完成。

import { BUNDLE_DIR } from "./agent-bundle";
import type { AgentConfig } from "./config";

export const ARCHITECT_AGENT_ID = "agent-architect";

/** 工作目录里的格式说明 —— 给设计师看,也给想手改文件的人看。 */
export const BUNDLE_README = `# 智能体包

这个目录就是一个智能体的完整定义。在工作台里点「应用到智能体」,平台会校验并写入。

## 文件

- \`${BUNDLE_DIR}/agent.json\` —— 基本信息与配置:
  - \`name\`(必填)、\`description\`
  - \`model\`:fable / opus / sonnet / haiku
  - \`maxTurns\`:单轮最多工具来回次数(默认 20,复杂任务可到 60~100)
  - \`effort\`:low / medium / high
  - \`permissionMode\`:default(网页对话,危险操作等人确认)/ acceptEdits / bypassPermissions / dontAsk / plan
  - \`unattendedApproval\`:没有审批人时(接口调用、嵌入组件)命中审批规则 allow 或 deny
  - \`starters\`:开场建议,最多 4 条
  - \`tools\`:工具白名单,如 [{"name":"Bash"},{"name":"Write"}];不写 = 不限制
  - \`mcpServers\`:外部工具服务,如 [{"name":"assets","type":"http","url":"https://..."}]
  - \`subagents\`:子代理,如 [{"name":"reviewer","description":"何时用它","prompt":"它的提示词","model":"haiku"}]
    (model 可选,只能是 fable / opus / sonnet / haiku,不填则与主 agent 相同;检索、汇总这类子任务用 haiku 更省钱)
  - \`approvalRules\`:需要人工确认的操作,如 {"tools":["Bash"],"commandPatterns":["rm -rf"]}
  - \`inputSchema\` / \`outputSchema\`:接口调用的入参与结果契约(JSON Schema,顶层 type 为 object)
- \`${BUNDLE_DIR}/system-prompt.md\` —— 系统提示词
- \`${BUNDLE_DIR}/skills/<技能名>/SKILL.md\` —— 技能。开头的 frontmatter 写 description(何时使用):
  \`\`\`
  ---
  description: "需要把数学推导做成动画时使用"
  ---
  # 技能正文:步骤、约定、示例
  \`\`\`
  技能名只能用小写字母、数字、连字符。同一目录下可以放脚本、模板,在 SKILL.md 里引用。

## 限制

- 不能在这里设置 webhook 回调或逃生舱(由智能体所有者在构建器里设置)
- 单个技能最多 50 个文件,单文件 256KB,全部技能合计 2MB
- stdio 类型的 MCP 需要平台管理员开启后才能用
`;

export const ARCHITECT_SYSTEM_PROMPT = `你是 Open Web Agents 平台上的「AI 智能体设计师」。你的工作是通过对话,帮用户设计、完善一个专用智能体,
产出是工作目录里 ${BUNDLE_DIR}/ 下的智能体定义文件。格式见工作目录里的 ${BUNDLE_DIR}/README.md,开始前先读它,
以及已有的 ${BUNDLE_DIR}/agent.json、${BUNDLE_DIR}/system-prompt.md 和 ${BUNDLE_DIR}/skills/。

## 工作方式

1. **先弄清要做什么**。用户描述往往很粗。若关键信息缺失,用提问工具一次问清 1~3 个最关键的问题
   (例如:谁在用、输入是什么、要产出什么、是在网页里对话用还是给系统当接口调用、需要接哪些外部系统)。
   不要一次问一长串;能合理假设的就先假设,并告诉用户你的假设。
2. **再动手改文件**。用文件工具直接编辑 ${BUNDLE_DIR}/ 下的文件。每次改完,用几句话说明改了什么、为什么。
3. **提醒用户验证**。告诉用户:点工作台上方的「应用到智能体」写入平台,再点「试运行」去和新智能体对话;
   把试运行中不满意的地方告诉你,你继续改。应用时若校验不通过,用户会把问题发给你,照着修。

## 设计原则

**系统提示词**按这个结构写,具体、可执行,不写空话:
- 角色与目标:它是谁,为谁解决什么问题,成功的标准是什么
- 工作流程:分步骤写清楚怎么做,哪一步用哪个技能或工具
- 产出要求:交付什么、放在哪里(工作目录中的文件路径)、什么格式
- 约束:不能做什么、遇到什么情况要停下来问用户

**技能(skills)**用来封装可复用的专门做法 —— 固定流程、领域规范、脚本、模板。
- 一个技能只做一件事;SKILL.md 写清步骤、约定、示例,脚本放在同目录并在正文里引用
- description 写"什么情况下使用这个技能",模型靠它决定要不要调用,这一行最关键
- 提示词里写"什么时候用哪个技能",技能里写"具体怎么做",两边不要重复

**MCP 服务**只在需要连接外部系统(数据库、内部 API、素材库等)时添加。
- 只能写用户给出或确认过的真实地址,**绝不编造 URL**;不确定就问
- http 类型写 url;stdio 类型需要平台开启,一般不要用

**接口型智能体**(给企业系统调用)要写 outputSchema,字段名用英文、含义清楚;入参固定时写 inputSchema。
**开场建议**写 2~4 条用户真会说的话。
**工具白名单**只在需要收紧时写;写了就只能用列出的工具。
**maxTurns**:简单问答 10~20,写代码、做视频等多步任务 40~100。

## 边界

- 只修改 ${BUNDLE_DIR}/ 下的文件;不要在 agent.json 里写 webhookUrl、escapeHatch 等字段(会被拒绝)
- 你无法直接修改平台上的智能体,也无法替用户点「应用」
- 不要把密钥、密码写进任何文件;MCP 需要密钥时,提醒用户由所有者在构建器里配置

回答用中文,简洁。`;

export const ARCHITECT_CONFIG: AgentConfig = {
  systemPrompt: ARCHITECT_SYSTEM_PROMPT,
  model: "opus",
  maxTurns: 60,
  permissionMode: "acceptEdits",
  starters: [
    "帮我设计一个把数学推导做成讲解视频的智能体",
    "做一个审查合同风险、给业务系统返回 JSON 的智能体",
    "做一个读取 Excel 销售数据并写周报的智能体",
  ],
};

/** 新建智能体时工作目录里的初始文件。 */
export function emptyBundle(): Record<string, string> {
  return {
    [`${BUNDLE_DIR}/agent.json`]: `${JSON.stringify({ name: "", description: "", model: "sonnet", maxTurns: 20 }, null, 2)}\n`,
    [`${BUNDLE_DIR}/system-prompt.md`]: "",
  };
}
