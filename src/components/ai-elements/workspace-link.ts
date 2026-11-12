/**
 * 对话正文里指向工作区文件的相对路径链接(如 `[初审结果.md](初审结果.md)`)。
 *
 * 【为什么要单独处理】Streamdown 的链接安全检查(rehype-harden)只认带协议或以 / ./ ../ 开头的地址,
 * 智能体最常写的裸相对路径会被拦成「初审结果.md [blocked]」,点不了。
 * 这里在 Markdown 语法树阶段把这类链接换成自定义标签 `owa-file`,绕开链接检查,
 * 由调用方渲染成「打开工作区文件」的按钮;http(s)、mailto 等外链原样交给 Streamdown 处理。
 */

/** 自定义标签名:调用方在 allowedTags 与 components 里登记它 */
export const WORKSPACE_LINK_TAG = "owa-file";

/**
 * 链接地址若是工作区里的相对路径,返回规范化后的路径(去掉 ./、查询与锚点,解码);否则 null。
 * 带协议(http:、mailto:、javascript: …)、协议相对(//)、站内绝对路径(/)、纯锚点(#)一律不是。
 */
export function workspacePathOf(href: unknown): string | null {
  if (typeof href !== "string") return null;
  const raw = href.trim();
  if (!raw || raw.startsWith("#") || raw.startsWith("/") || raw.startsWith("\\")) return null;
  // 协议:字母开头、冒号前只有字母数字 + - .(Windows 盘符 C: 也算,不当工作区路径)
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  let path = raw.replace(/[?#].*$/, "");
  try {
    path = decodeURIComponent(path);
  } catch {
    // 不是合法的百分号编码就按原文
  }
  const parts: string[] = [];
  for (const seg of path.split("/")) {
    if (!seg || seg === ".") continue;
    // 越出工作区根目录的不认
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.length > 0 ? parts.join("/") : null;
}

interface MdNode {
  type: string;
  url?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

/** remark 插件:把指向工作区文件的链接改成 `<owa-file path="…">` */
export function remarkWorkspaceLinks() {
  const walk = (node: MdNode) => {
    if (node.type === "link") {
      const path = workspacePathOf(node.url);
      if (path) {
        node.data = { ...node.data, hName: WORKSPACE_LINK_TAG, hProperties: { path } };
      }
    }
    for (const child of node.children ?? []) walk(child);
  };
  return (tree: MdNode) => walk(tree);
}
