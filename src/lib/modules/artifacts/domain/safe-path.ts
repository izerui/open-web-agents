// 工作空间内的安全路径解析。纯逻辑(只算路径,不碰 IO)。
//
// 这是文件接口的守门人:相对路径来自 HTTP 查询参数,若不挡住 `..`、绝对路径、符号链接式
// 拼接,调用方就能读到工作空间之外的任意文件(密钥、其它租户的会话)。

import path from "node:path";

export class PathEscapeError extends Error {
  constructor(rel: string) {
    super(`path escapes workspace: ${JSON.stringify(rel)}`);
    this.name = "PathEscapeError";
  }
}

/**
 * 把工作空间内的相对路径解析成绝对路径,并保证结果仍在工作空间内。
 *
 * 判定用 path.relative:结果若以 `..` 开头或本身是绝对路径,说明跑到了根之外。
 * 这比字符串前缀比较可靠 —— 能挡住 `/ws/s1-evil` 这种"看着像前缀"的兄弟目录。
 */
export function resolveInWorkspace(workspaceDir: string, relPath: string): string {
  const root = path.resolve(workspaceDir);
  const target = path.resolve(root, relPath);

  if (target === root) return root;

  const rel = path.relative(root, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new PathEscapeError(relPath);
  }
  return target;
}

/** 该路径是否应对用户隐藏(agent 运行时的内部产物)。 */
export function isHiddenEntry(name: string): boolean {
  return name.startsWith(".");
}
