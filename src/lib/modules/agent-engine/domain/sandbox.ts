// 执行隔离策略的物化。纯逻辑(只算配置,不碰 IO),可穷举单测。
//
// 为什么必须有这层 —— 实测教训:
// 只靠"给 agent 一个 cwd"不构成隔离。模型完全可以用【绝对路径】写到工作空间之外
// (实测 agent 把产物写进了宿主 HOME)。cwd 只是默认起点,不是围栏。
//
// 两道防线,缺一不可:
// ① sandbox.filesystem —— 内核级(macOS seatbelt / Linux bubblewrap)限制 Bash 子进程可写目录。
//    命令怎么写都绕不过,因为不是文本匹配。
// ② disallowedTools —— sandbox 只管 Bash;Read/Edit/Write 跑在 SDK 宿主进程里、不受沙箱约束,
//    故按同一策略生成原生 deny 规则(bypassPermissions 下依然生效)。

import path from "node:path";

export interface SandboxPolicy {
  /** 关掉内核沙箱(macOS 本地开发:seatbelt 会吞掉沙箱内 Bash 的 stdout)。 */
  enabled: boolean;
  /** 本次会话的工作目录,唯一应当可写的业务目录。 */
  workspaceDir: string;
  /** agent 共享 HOME:工具缓存要可写,否则 matplotlib/pip 之类直接 EACCES。 */
  sharedHome: string;
  /** 系统临时目录,latex/ffmpeg 等大量工具依赖。 */
  tmpDirs?: string[];
  /** 额外可写目录(业务按需放开)。 */
  extraWriteDirs?: string[];
  /** 内核级禁读目录(密钥所在)。 */
  denyReadDirs?: string[];
}

export interface MaterializedSandbox {
  /** 传给 SDK options.sandbox;沙箱关闭时为 undefined。 */
  sandbox?: Record<string, unknown>;
  /** 传给 SDK options.disallowedTools;即便沙箱关闭也应生效。 */
  disallowedTools: string[];
}

const DEFAULT_DENY_READ = ["~/.ssh", "~/.aws", "~/.gnupg", "~/.claude", "~/.config/gcloud"];
const DEFAULT_TMP = ["/tmp", "/private/tmp", "/private/var/folders", "/var/tmp"];

/** `~` 按 agent 实际 HOME(sharedHome)展开,与注入的 HOME 自洽。 */
function expandHome(p: string, home: string): string {
  return p.startsWith("~") ? path.join(home, p.slice(1)) : p;
}

/**
 * 把隔离策略物化成 SDK 原生设置。
 *
 * 注意 disallowedTools 是【deny 列表】,表达不了"仅允许工作空间"这种 allow 语义。
 * 故它只用来堵明确的敏感位置;真正的围栏靠内核沙箱的 allowWrite 白名单。
 * 沙箱关闭时(本地开发)隔离退化为 best-effort —— 这一点必须让运维知道。
 */
export function materializeSandbox(policy: SandboxPolicy): MaterializedSandbox {
  const denyRead = (policy.denyReadDirs ?? DEFAULT_DENY_READ).map((p) =>
    expandHome(p, policy.sharedHome),
  );

  // 宿主进程侧的 Read/Edit/Write 不受内核沙箱管,按同一策略生成 deny 规则
  const disallowedTools = denyRead.flatMap((d) => [
    `Read(${d}/**)`,
    `Edit(${d}/**)`,
    `Write(${d}/**)`,
  ]);

  if (!policy.enabled) {
    return { disallowedTools };
  }

  return {
    sandbox: {
      enabled: true,
      // 起不来一律硬失败,绝不裸跑 —— 想不用沙箱只能显式关掉总开关
      failIfUnavailable: true,
      // 沙箱本身即护栏,bash 不必再逐条弹窗
      autoAllowBashIfSandboxed: true,
      // 禁止模型用 dangerouslyDisableSandbox 逃逸
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: [
          policy.workspaceDir,
          policy.sharedHome,
          ...(policy.tmpDirs ?? DEFAULT_TMP),
          // 不少工具要写 /dev/null
          "/dev",
          ...(policy.extraWriteDirs ?? []),
        ],
        denyRead,
      },
    },
    disallowedTools,
  };
}
