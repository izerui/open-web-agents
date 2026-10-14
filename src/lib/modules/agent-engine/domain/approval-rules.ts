// 审批规则:判定某次工具调用是否需要人工确认(HITL)。
// 纯逻辑,零 IO —— 规则能被穷举单测。
//
// 与工具守卫(tool-guard)的分工:
// - 守卫:结构性违规,【直接拒绝】,没有商量余地(写到工作空间外)
// - 审批:合法但有风险,【交给人判断】(删文件、装依赖、发网络请求)
// 顺序必须是先守卫后审批 —— 越界操作不该浪费人的注意力去审。

export interface ApprovalRules {
  /** 这些工具的每次调用都要审批。 */
  tools?: string[];
  /** Bash 命令匹配任一模式就要审批(字符串按子串匹配,大小写不敏感)。 */
  commandPatterns?: string[];
  /** 全部工具都要审批 —— 极端谨慎场景。 */
  all?: boolean;
}

export interface ApprovalNeed {
  needed: boolean;
  /** 为什么需要审批,直接展示给审批人。 */
  reason?: string;
  /**
   * 这次调用属于哪一类 —— 审批人选"本会话内同类不再询问"时,授权的就是这一类。
   * 按命中的那条规则划分:命中工具规则就是这个工具;命中命令模式就只是含该模式的命令,
   * 不会顺带放行同一工具的其它高风险命令。
   */
  grant?: ApprovalGrantScope;
}

export interface ApprovalGrantScope {
  /** 稳定的类别键,如 `tool:Write`、`bash:curl` */
  key: string;
  /** 给人看的说明 */
  label: string;
}

const NOT_NEEDED: ApprovalNeed = { needed: false };

/**
 * 默认的高风险命令模式。
 * 这些不是"绝对危险",而是"值得让人看一眼" —— 删除、提权、装东西、往外发数据。
 */
export const DEFAULT_RISKY_PATTERNS = [
  "rm -rf",
  "sudo",
  "chmod 777",
  "curl",
  "wget",
  "npm install",
  "pip install",
  "git push",
  "> /dev/",
  "mkfs",
  "dd if=",
];

function commandOf(input: Record<string, unknown>): string {
  const c = input.command;
  return typeof c === "string" ? c : "";
}

/**
 * 判定是否需要人工审批。
 * 未配置任何规则时一律不需要 —— 审批是显式开启的能力,不能默认卡住所有智能体。
 */
export function needsApproval(
  toolName: string,
  input: Record<string, unknown>,
  rules: ApprovalRules | undefined,
): ApprovalNeed {
  if (!rules) return NOT_NEEDED;

  const toolScope = { key: `tool:${toolName}`, label: `工具 ${toolName}` };
  if (rules.all) {
    return { needed: true, reason: "该智能体配置了全部工具调用均需审批", grant: toolScope };
  }

  if (rules.tools?.includes(toolName)) {
    return { needed: true, reason: `工具 ${toolName} 被配置为需审批`, grant: toolScope };
  }

  const patterns = rules.commandPatterns;
  if (patterns?.length && toolName === "Bash") {
    const cmd = commandOf(input).toLowerCase();
    const hit = patterns.find((p) => p && cmd.includes(p.toLowerCase()));
    if (hit) {
      return {
        needed: true,
        reason: `命令包含高风险模式:${hit}`,
        grant: { key: `bash:${hit.toLowerCase()}`, label: `含「${hit}」的命令` },
      };
    }
  }

  return NOT_NEEDED;
}

/** 给审批人看的摘要:够判断,又不至于把整个入参糊上去。 */
export function describeToolCall(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash") {
    const cmd = commandOf(input);
    return cmd.length > 300 ? `${cmd.slice(0, 300)}…` : cmd;
  }
  const path = input.file_path ?? input.notebook_path;
  if (typeof path === "string") return path;

  const json = JSON.stringify(input);
  return json.length > 300 ? `${json.slice(0, 300)}…` : json;
}
