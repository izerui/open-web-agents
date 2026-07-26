import fs from "node:fs/promises";
import path from "node:path";
import { isTextMime, mimeOf } from "@/lib/modules/artifacts/domain/mime";
import { isHiddenEntry, resolveInWorkspace } from "@/lib/modules/artifacts/domain/safe-path";
import type { FileNode, FilePreview, StoragePort } from "@/lib/modules/artifacts/ports";

/** 文本预览上限:超过就截断,完整内容走下载。 */
const PREVIEW_LIMIT = 256 * 1024;

export class LocalFsStorage implements StoragePort {
  async tree(workspaceDir: string, relDir: string): Promise<FileNode[]> {
    const abs = resolveInWorkspace(workspaceDir, relDir);
    const entries = await fs.readdir(abs, { withFileTypes: true });

    const nodes = await Promise.all(
      entries
        .filter((e) => !isHiddenEntry(e.name))
        .map(async (e): Promise<FileNode> => {
          const rel = path.posix.join(relDir.replace(/\\/g, "/"), e.name).replace(/^\.\//, "");
          const node: FileNode = {
            path: rel,
            name: e.name,
            type: e.isDirectory() ? "dir" : "file",
          };
          if (!e.isDirectory()) {
            try {
              const st = await fs.stat(path.join(abs, e.name));
              node.size = st.size;
              node.mtime = st.mtimeMs;
            } catch {
              // 竞态:列举后文件被 agent 删了,跳过大小信息即可
            }
          }
          return node;
        }),
    );

    // 目录在前,同类按名排序
    return nodes.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
    );
  }

  async preview(workspaceDir: string, relPath: string): Promise<FilePreview> {
    const abs = resolveInWorkspace(workspaceDir, relPath);
    const st = await fs.stat(abs);
    const mime = mimeOf(relPath);

    if (!isTextMime(mime)) {
      return { path: relPath, mime, size: st.size, text: null, truncated: false };
    }

    const handle = await fs.open(abs, "r");
    try {
      const len = Math.min(st.size, PREVIEW_LIMIT);
      const buf = Buffer.alloc(len);
      await handle.read(buf, 0, len, 0);
      return {
        path: relPath,
        mime,
        size: st.size,
        text: buf.toString("utf8"),
        truncated: st.size > PREVIEW_LIMIT,
      };
    } finally {
      await handle.close();
    }
  }

  async read(workspaceDir: string, relPath: string): Promise<{ bytes: Buffer; mime: string }> {
    const abs = resolveInWorkspace(workspaceDir, relPath);
    return { bytes: await fs.readFile(abs), mime: mimeOf(relPath) };
  }
}
