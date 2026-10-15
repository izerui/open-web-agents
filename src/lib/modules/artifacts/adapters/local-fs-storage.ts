import { createReadStream, constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { isTextMime, mimeOf } from "@/lib/modules/artifacts/domain/mime";
import {
  PathEscapeError,
  isHiddenEntry,
  resolveInWorkspace,
} from "@/lib/modules/artifacts/domain/safe-path";
import type { FileNode, FilePreview, StoragePort } from "@/lib/modules/artifacts/ports";

/** 文本预览上限:超过就截断,完整内容走下载。 */
const PREVIEW_LIMIT = 256 * 1024;

/**
 * 路径算完还要落地核对一次真实路径。
 *
 * resolveInWorkspace 是纯路径计算,path.resolve 【不跟随符号链接】,而随后的
 * fs.readFile 会跟随 —— 于是 agent 在自己工作目录里 `ln -s / root_link` 之后,
 * `?download=root_link/etc/passwd` 能算出"在工作区内"的结论,实际读到宿主根下的文件:
 * /proc/self/environ 里有 OWA_SECRET_KEY 与数据库连接串,其它租户的产物也一并暴露。
 *
 * 纯逻辑层修不了这个 —— 判定符号链接必然要碰 IO,所以守卫必须落在这一层。
 * 文件不存在时(ENOENT)不拦,交给后续的 readFile 抛出正常的"找不到"。
 */
async function assertRealPathInside(workspaceDir: string, abs: string): Promise<void> {
  const root = await fs
    .realpath(path.resolve(workspaceDir))
    .catch(() => path.resolve(workspaceDir));
  const real = await fs.realpath(abs).catch(() => null);
  if (real === null) return;
  const rel = path.relative(root, real);
  if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) {
    throw new PathEscapeError(path.relative(path.resolve(workspaceDir), abs));
  }
}

export class LocalFsStorage implements StoragePort {
  async tree(workspaceDir: string, relDir: string): Promise<FileNode[]> {
    const abs = resolveInWorkspace(workspaceDir, relDir);
    await assertRealPathInside(workspaceDir, abs);
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
    await assertRealPathInside(workspaceDir, abs);
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

  async write(
    workspaceDir: string,
    relPath: string,
    bytes: Buffer,
    opts: { overwrite?: boolean } = {},
  ): Promise<void> {
    const abs = resolveInWorkspace(workspaceDir, relPath);
    await assertRealPathInside(workspaceDir, abs);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    // 文件还不存在时,上面那次检查拿不到 realpath 就放行了 —— 但父目录可能是指向工作目录
    // 之外的符号链接(agent 能在自己的工作目录里建链接),写入会顺着它逃出去。再查一次父目录。
    await assertRealPathInside(workspaceDir, path.dirname(abs));
    if (!opts.overwrite) {
      await fs.writeFile(abs, bytes, { flag: "wx" });
      return;
    }
    // 覆盖写:O_NOFOLLOW 拒绝最后一段是符号链接(否则会顺着链接改掉它指向的文件)
    const { O_WRONLY, O_CREAT, O_TRUNC, O_NOFOLLOW } = fsConstants;
    const handle = await fs.open(abs, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o644);
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
  }

  async read(workspaceDir: string, relPath: string): Promise<{ bytes: Buffer; mime: string }> {
    const abs = resolveInWorkspace(workspaceDir, relPath);
    await assertRealPathInside(workspaceDir, abs);
    return { bytes: await fs.readFile(abs), mime: mimeOf(relPath) };
  }

  async stream(
    workspaceDir: string,
    relPath: string,
    range?: { start: number; end: number },
  ): Promise<{ stream: ReadableStream<Uint8Array>; size: number; mime: string }> {
    const abs = resolveInWorkspace(workspaceDir, relPath);
    await assertRealPathInside(workspaceDir, abs);
    const stat = await fs.stat(abs);
    const nodeStream = createReadStream(
      abs,
      range ? { start: range.start, end: range.end } : undefined,
    );
    return {
      stream: Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>,
      size: stat.size,
      mime: mimeOf(relPath),
    };
  }
}
