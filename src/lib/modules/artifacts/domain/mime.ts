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
