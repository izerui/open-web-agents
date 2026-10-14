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
 * 把工作目录的绝对路径编码成 SDK 的 projects 子目录名:字母数字以外的字符都换成短横线。
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
 * 【完整规则(scripts/sdk-probe/project-dir-encoding.mjs 实测)】不只是 `/` 与 `.`:
 * 字母数字以外的【每个】字符都换成一个短横线 —— 下划线、空格、`+@~`、每个中文字符都是。
 * 曾经只换 `/` 与 `.`,数据目录含下划线(如 /srv/owa_data)的部署历史回放整片空白;
 * 是读不到时的告警探针在 macOS 临时目录(路径里有下划线)上撞出来的。
 *
 * 另外 SDK 用的是工作目录的【真实路径】(符号链接已解析)—— 那一步需要读盘,
 * 由调用方先做(见 JsonlTranscript),这里只管字符替换。
 */
export function projectDirNameFor(workspaceDir: string): string {
  if (!path.isAbsolute(workspaceDir)) {
    // 相对路径推出来的目录名必然与 SDK 写的对不上,且错得很安静。早失败。
    throw new Error(`workspaceDir must be absolute: ${JSON.stringify(workspaceDir)}`);
  }
  return workspaceDir.replace(/[^A-Za-z0-9]/g, "-");
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
