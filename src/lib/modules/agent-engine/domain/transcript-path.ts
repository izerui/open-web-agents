// SDK transcript(jsonl)的路径推导。纯逻辑(只算路径,不碰 IO),便于穷举边界。
//
// 【为什么这段规则必须集中在一处】Claude Agent SDK 把每次会话的完整过程写成 jsonl,
// 路径由它自己按 cwd 编码决定 —— 不是我们能配置的。推错一个字符就整个读不到,
// 而"读不到"的表现是空白页面而非报错,极难归因。所以规则只此一份,并由测试对着
// 真实盘上的目录名钉死(见 __tests__/transcript-path.test.ts)。
//
// agents.md §7.1 早就写明"transcript 读写必须使用同一套路径推导规则",这就是那一套。

import path from "node:path";

/**
 * SDK 会话 id 会成为 jsonl 的文件名,必须挡住穿越。
 *
 * 它来自 DB(runs.sdk_session_id),而 DB 里的值最初来自 SDK 的 system:init 消息 ——
 * 中间隔了两跳,任何一跳被污染都会变成任意文件读。宁可白校验一次。
 */
const SAFE_SDK_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isSafeSdkSessionId(id: string): boolean {
  return SAFE_SDK_SESSION_ID.test(id);
}

/**
 * 把工作目录的绝对路径编码成 SDK 的 projects 子目录名:分隔符与点都换成短横线。
 *
 * 例:/srv/owa/data/workspaces/s1 → -srv-owa-data-workspaces-s1
 * (前导 `/` 也参与替换,所以结果以短横线开头 —— 这与盘上实际形态一致。)
 *
 * 【点为什么也要换】曾经只换分隔符,于是含点的路径整个读不到。真实反例(本机盘上):
 *   cwd  = /Users/x/open-web-agents/.claude/worktrees/streaming-fix
 *   目录 = -Users-x-open-web-agents--claude-worktrees-streaming-fix
 * `.claude` 变成 `--claude` —— 分隔符和点各贡献一个短横线,而不是 `-.claude`。
 * 这不需要改代码就能踩到:`OWA_DATA_DIR=/srv/app.v2/data` 这样的部署配置即可,
 * 而失败表现是空白页面不是报错。
 *
 * 【已知边界】只对 `/` 与 `.` 两个字符有实证。SDK 对空格、中文等是否另有替换规则
 * 尚无反例可查 —— 故 JsonlTranscript 读不到文件时会扫一眼 projects 目录并告警,
 * 免得下一个未知字符再以"静默空白"的形式出现。
 */
export function projectDirNameFor(workspaceDir: string): string {
  if (!path.isAbsolute(workspaceDir)) {
    // 相对路径推出来的目录名必然与 SDK 写的对不上,且错得很安静。早失败。
    throw new Error(`workspaceDir must be absolute: ${JSON.stringify(workspaceDir)}`);
  }
  return workspaceDir.split(path.sep).join("-").replaceAll(".", "-");
}

/** 算出某次 SDK 会话的 transcript 文件绝对路径。 */
export function transcriptPathFor(args: {
  dataDir: string;
  workspaceDir: string;
  sdkSessionId: string;
}): string {
  const { dataDir, workspaceDir, sdkSessionId } = args;
  if (!isSafeSdkSessionId(sdkSessionId)) {
    throw new Error(`unsafe sdk session id: ${JSON.stringify(sdkSessionId)}`);
  }
  return path.join(
    path.resolve(dataDir),
    ".agent-home",
    ".claude",
    "projects",
    projectDirNameFor(workspaceDir),
    `${sdkSessionId}.jsonl`,
  );
}
