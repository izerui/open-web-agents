// 由扩展名推断 MIME 与可预览性。纯逻辑。

const TEXT_EXT: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".jsx": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".xml": "text/xml",
  ".yml": "text/yaml",
  ".yaml": "text/yaml",
  ".csv": "text/csv",
  ".py": "text/x-python",
  ".sh": "text/x-shellscript",
  ".sql": "text/x-sql",
  ".log": "text/plain",
  ".env": "text/plain",
};

const BINARY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".zip": "application/zip",
};

function extOf(p: string): string {
  const i = p.lastIndexOf(".");
  return i === -1 ? "" : p.slice(i).toLowerCase();
}

export function mimeOf(filePath: string): string {
  const ext = extOf(filePath);
  return TEXT_EXT[ext] ?? BINARY_EXT[ext] ?? "application/octet-stream";
}

/** 能否当文本预览。未知扩展名保守当二进制,避免把乱码塞进前端。 */
export function isTextMime(mime: string): boolean {
  return mime.startsWith("text/") || mime === "application/json";
}

/**
 * 能否让浏览器【内联】渲染这个文件(Content-Disposition: inline)。
 *
 * 【为什么只放行图片】内联意味着浏览器会在【本站源】下解析这份内容。
 * 对 text/html 放行等于把 agent 写出来的任意 HTML 挂到自己域名下执行 ——
 * 那是一个可以读 cookie、发同源请求的 XSS,而 agent 的产物完全可能来自
 * 被注入的提示词。HTML 预览走 iframe 的 srcdoc + sandbox,不经过这条路径。
 *
 * SVG 也是图片,但它能带脚本;放行它的前提是响应同时带上
 * `Content-Security-Policy: sandbox` 与 `X-Content-Type-Options: nosniff`
 * (见 files 路由),让它即使被直接访问也跑不了脚本。
 */
export function canRenderInline(mime: string): boolean {
  return mime.startsWith("image/");
}
