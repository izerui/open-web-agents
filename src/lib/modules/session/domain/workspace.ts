// 会话工作空间路径解析。纯逻辑(只算路径,不碰 IO),便于单测边界情况。

import path from "node:path";

/** 会话 id 只允许安全字符 —— 它会成为磁盘目录名。 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isSafeSessionId(id: string): boolean {
  return SAFE_ID.test(id);
}

/**
 * 算出会话的工作目录绝对路径(= 项目 = 工作空间,一对一)。
 *
 * 会话 id 直接参与路径拼接,必须挡住 `..`、绝对路径、分隔符等穿越尝试 —— 否则
 * agent 的 cwd 会被指到工作空间之外,沙箱白名单也就形同虚设。
 */
export function workspacePathFor(dataDir: string, sessionId: string): string {
  if (!isSafeSessionId(sessionId)) {
    throw new Error(`unsafe session id: ${JSON.stringify(sessionId)}`);
  }
  const root = path.resolve(dataDir, "workspaces");
  const dir = path.resolve(root, sessionId);
  // 双保险:即便正则被绕过,也不允许逃出 workspaces 根
  if (dir !== path.join(root, sessionId) || !dir.startsWith(`${root}${path.sep}`)) {
    throw new Error(`workspace path escapes root: ${sessionId}`);
  }
  return dir;
}
