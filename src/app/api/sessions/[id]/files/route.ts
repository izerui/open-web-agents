import fs from "node:fs/promises";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { canRenderInline, mimeOf } from "@/lib/modules/artifacts/domain/mime";
import { PathEscapeError, resolveInWorkspace } from "@/lib/modules/artifacts/domain/safe-path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" };

/**
 * 工作空间文件接口。
 *
 * - `?dir=sub`      → 列目录
 * - `?file=a.md`    → 预览(文本截断,二进制只回元信息)
 * - `?download=a.md`→ 下载原始字节(默认 attachment)
 * - `?download=a.png&inline=1` → 内联渲染,【仅图片】,用于界面里直接展示产物
 *
 * 所有路径都经 resolveInWorkspace 收敛在会话工作目录内,穿越一律 400。
 * 访问前先过会话归属校验 —— 工作空间里可能有别人的敏感产物。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { sessions, storage, auth } = getContainer();

  try {
    const principal = await auth.resolveWeb(req);
    await auth.assertSessionAccess(principal, id);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const session = await sessions.get(id);
  if (!session) return Response.json({ error: "session not found" }, { status: 404 });
  if (session.source === "design") {
    return Response.json({ error: "请通过 AI 编辑页面更新设计草稿" }, { status: 403 });
  }

  const form = await req.formData().catch(() => null);
  const files = form?.getAll("files").filter((value): value is File => value instanceof File) ?? [];
  if (files.length === 0) return Response.json({ error: "files are required" }, { status: 400 });
  if (files.length > 20) return Response.json({ error: "too many files" }, { status: 413 });

  // 显式 ?overwrite=1 才覆盖同名文件(例如手改后重新上传智能体定义);默认只新建,保护已有附件
  const overwrite = new URL(req.url).searchParams.get("overwrite") === "1";
  const names = new Set<string>();
  try {
    // 先把整批可预见错误验完，再开始写。否则第 1 个文件已经落盘，
    // 第 2 个才因过大、重名或越界失败，用户重试时又会撞上残留文件。
    for (const file of files) {
      if (file.size > 10 * 1024 * 1024) {
        return Response.json({ error: `file too large: ${file.name}` }, { status: 413 });
      }
      if (names.has(file.name)) {
        return Response.json({ error: `duplicate file name: ${file.name}` }, { status: 409 });
      }
      names.add(file.name);
      resolveInWorkspace(session.workspaceDir, file.name);
    }

    const prepared = await Promise.all(
      files.map(async (file) => ({ file, bytes: Buffer.from(await file.arrayBuffer()) })),
    );
    /*
     * 写之前先走工作目录协议:在会话行锁内记下"刚用过"并确保目录存在。
     * 上传不产生运行 —— 不记这一笔,GC 只看运行时间,长期未活动的会话里刚上传的文件
     * 可能马上被清掉;GC 正在改名挪走目录时,这里会等它挪完再建新目录。
     */
    await sessions.prepareWorkspace(id, { nowMs: Date.now() }, async () => {
      await fs.mkdir(session.workspaceDir, { recursive: true });
    });
    const uploaded: string[] = [];
    for (const { file, bytes } of prepared) {
      await storage.write(session.workspaceDir, file.name, bytes, { overwrite });
      uploaded.push(file.name);
    }
    return Response.json({ files: uploaded }, { headers: NO_STORE_HEADERS });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "EEXIST") {
      return Response.json({ error: "a file with the same name already exists" }, { status: 409 });
    }
    if (err instanceof PathEscapeError) {
      return Response.json({ error: "invalid file name" }, { status: 400 });
    }
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { sessions, storage, auth } = getContainer();

  try {
    const principal = await auth.resolveWeb(req);
    await auth.assertSessionAccess(principal, id);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const session = await sessions.get(id);
  if (!session) return Response.json({ error: "session not found" }, { status: 404 });

  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return Response.json({ error: "invalid request URL" }, { status: 400 });
  }
  const dir = url.searchParams.get("dir");
  const file = url.searchParams.get("file");
  const download = url.searchParams.get("download");
  const wantInline = url.searchParams.get("inline") !== null;

  try {
    if (download !== null) {
      const mime = mimeOf(download);
      const filename = download.split("/").pop() ?? "download";
      const inline = wantInline && canRenderInline(mime);

      if (inline && (mime.startsWith("video/") || mime.startsWith("audio/"))) {
        return await streamResponse(req, storage, session.workspaceDir, download, mime, filename);
      }

      const { bytes } = await storage.read(session.workspaceDir, download);
      const csp =
        mime === "application/pdf"
          ? "sandbox; default-src 'self'; style-src 'unsafe-inline'"
          : "sandbox; default-src 'none'; style-src 'unsafe-inline'";

      return new Response(new Uint8Array(bytes), {
        headers: {
          "Content-Type": mime,
          "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(filename)}"`,
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": csp,
          ...NO_STORE_HEADERS,
        },
      });
    }

    if (file !== null) {
      return Response.json(
        { preview: await storage.preview(session.workspaceDir, file) },
        { headers: NO_STORE_HEADERS },
      );
    }

    return Response.json(
      { nodes: await storage.tree(session.workspaceDir, dir ?? "") },
      { headers: NO_STORE_HEADERS },
    );
  } catch (err) {
    if (err instanceof PathEscapeError) {
      return Response.json({ error: "path escapes workspace" }, { status: 400 });
    }
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d+)-(\d*)$/.exec(header);
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start > end || start >= size) return null;
  return { start, end };
}

async function streamResponse(
  req: Request,
  storage: import("@/lib/modules/artifacts/ports").StoragePort,
  workspaceDir: string,
  relPath: string,
  mime: string,
  filename: string,
): Promise<Response> {
  const { stream: fullStream, size } = await storage.stream(workspaceDir, relPath);
  const rangeHeader = req.headers.get("range");
  const range = parseRange(rangeHeader, size);

  const headers: Record<string, string> = {
    "Content-Type": mime,
    "Content-Disposition": `inline; filename="${encodeURIComponent(filename)}"`,
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
    ...NO_STORE_HEADERS,
  };

  if (!range) {
    headers["Content-Length"] = String(size);
    return new Response(fullStream, { headers });
  }

  await fullStream.cancel();
  const { stream: rangeStream } = await storage.stream(workspaceDir, relPath, range);
  headers["Content-Length"] = String(range.end - range.start + 1);
  headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
  return new Response(rangeStream, { status: 206, headers });
}
