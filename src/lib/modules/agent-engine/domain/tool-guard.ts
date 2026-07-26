// 工具调用守卫:在工具真正执行前按路径判定,把越界访问拦在工作空间之外。
// 纯逻辑(只算路径、不碰 IO),规则能被穷举单测。
//
// 为什么需要它 —— 两次真实事故:
// agent 用【绝对路径】通过 Write 工具把产物写到了宿主 HOME。当时沙箱是关的
// (macOS seatbelt 会吞掉 Bash 的 stdout,本地开发只能关),于是完全没有阻挡。
// cwd 只是默认起点、不是围栏。
//
// 与内核沙箱的分工:
// - 宿主侧文件工具(Write/Edit/Read/NotebookEdit)跑在 SDK 宿主进程里、不受内核沙箱管,
//   但它们的目标路径是【结构化参数】,可以可靠地判定 → 由本守卫负责,始终生效
// - Bash 执行任意命令,路径藏在命令文本里,文本匹配不可信(引号/变量/拼接都能绕)
//   → 只能靠内核或容器沙箱,本守卫不假装能管

import path from "node:path";

export interface GuardPolicy {
  /** 唯一允许读写的业务目录(绝对路径)。 */
  workspaceDir: string;
  /** 额外允许的目录:agent 共享 HOME、临时目录等(工具缓存需要)。 */
  allowedDirs?: string[];
  /** 是否连读也限制在允许目录内。读通常放宽:agent 需要读系统文件/文档。 */
  restrictReads?: boolean;
}

export type GuardDecision = { allow: true } | { allow: false; reason: string };

const ALLOW: GuardDecision = { allow: true };

/** 会写文件的宿主侧工具 → 其路径参数名。 */
const WRITE_TOOLS: Record<string, string[]> = {
  Write: ["file_path"],
  Edit: ["file_path"],
  NotebookEdit: ["notebook_path"],
};

/** 会读文件的宿主侧工具。 */
const READ_TOOLS: Record<string, string[]> = {
  Read: ["file_path"],
};

/**
 * 相对路径的基准【必须是 agent 的工作目录】,不是服务进程的 cwd。
 *
 * agent 的 cwd 就是 workspaceDir(见 options.ts),它发出的 `Write{file_path:"out.txt"}`
 * 是再正常不过的调用。曾经这里直接 path.resolve(target),相对路径按服务进程的 cwd 解析,
 * 于是两头都错:正常的相对写入被拒(理由文案还误导性地说"工作空间之外");
 * 而当服务进程的 cwd 恰好落在某个 allowedDirs(/tmp、共享 HOME 都在列)时,
 * 相对路径写入反被放行、文件落到工作空间外 —— 正是本守卫要防的那类事故。
 */
function resolveTarget(target: string, policy: GuardPolicy): string {
  return path.isAbsolute(target) ? path.resolve(target) : path.resolve(policy.workspaceDir, target);
}

/** 路径是否落在某个允许目录内。用 path.relative 判定,能挡住 `/ws-evil` 这类伪前缀。 */
function isInside(resolvedTarget: string, dir: string): boolean {
  const rel = path.relative(path.resolve(dir), resolvedTarget);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function allowedFor(policy: GuardPolicy): string[] {
  return [policy.workspaceDir, ...(policy.allowedDirs ?? [])];
}

/**
 * 判定一次工具调用是否放行。
 *
 * 未识别的工具一律放行 —— 守卫只负责它确知语义的文件工具;
 * 把未知工具默认拒掉会在 SDK 新增工具时静默弄坏助手。
 */
export function guardToolUse(
  toolName: string,
  input: Record<string, unknown>,
  policy: GuardPolicy,
): GuardDecision {
  const dirs = allowedFor(policy);

  const writeParams = WRITE_TOOLS[toolName];
  if (writeParams) {
    for (const p of writeParams) {
      const target = input[p];
      if (typeof target !== "string" || !target) continue;
      const resolved = resolveTarget(target, policy);
      if (!dirs.some((d) => isInside(resolved, d))) {
        return {
          allow: false,
          reason: `拒绝写入工作空间之外的路径:${target}(允许:${policy.workspaceDir})`,
        };
      }
    }
    return ALLOW;
  }

  if (policy.restrictReads) {
    const readParams = READ_TOOLS[toolName];
    if (readParams) {
      for (const p of readParams) {
        const target = input[p];
        if (typeof target !== "string" || !target) continue;
        const resolved = resolveTarget(target, policy);
        if (!dirs.some((d) => isInside(resolved, d))) {
          return { allow: false, reason: `拒绝读取工作空间之外的路径:${target}` };
        }
      }
    }
  }

  return ALLOW;
}

/** 守卫是否覆盖该工具 —— 供上层判断"这个工具的隔离是否还依赖沙箱"。 */
export function isGuardedTool(toolName: string): boolean {
  return toolName in WRITE_TOOLS || toolName in READ_TOOLS;
}
