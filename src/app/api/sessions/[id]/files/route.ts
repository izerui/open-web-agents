import { uploadToWorkspace } from "@/app/api/_lib/workspace-upload";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { canRenderInline, mimeOf } from "@/lib/modules/artifacts/domain/mime";
import { PathEscapeError } from "@/lib/modules/artifacts/domain/safe-path";

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
    // 设计会话的附件走 /api/agents/design/[id]/files(保护设计草稿文件)
    return Response.json({ error: "请通过 AI 编辑页面更新设计草稿" }, { status: 403 });
  }

  // 显式 ?overwrite=1 才覆盖同名文件(例如手改后重新上传智能体定义);默认只新建,保护已有附件
  const overwrite = new URL(req.url).searchParams.get("overwrite") === "1";
  return uploadToWorkspace(
    req,
    { sessionId: id, workspaceDir: session.workspaceDir },
    { sessions, storage },
    { overwrite },
  );
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

type RangeResult = { ok: true; start: number; end: number } | { ok: false } | null;

function parseRange(header: string | null, size: number): RangeResult {
  if (!header) return null;
  // bytes=start-end, bytes=start-, bytes=-suffix
  const m = /^bytes=(\d+)-(\d*)$/.exec(header);
  if (m) {
    const start = Number(m[1]);
    const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || start > end) return { ok: false };
    return { ok: true, start, end };
  }
  const suffix = /^bytes=-(\d+)$/.exec(header);
  if (suffix) {
    const len = Number(suffix[1]);
    if (len === 0) return { ok: false };
    const start = Math.max(0, size - len);
    return { ok: true, start, end: size - 1 };
  }
  return { ok: false };
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

  if (range === null) {
    headers["Content-Length"] = String(size);
    return new Response(fullStream, { headers });
  }

  await fullStream.cancel();

  if (!range.ok) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${size}`, ...NO_STORE_HEADERS },
    });
  }

  const { stream: rangeStream } = await storage.stream(workspaceDir, relPath, range);
  headers["Content-Length"] = String(range.end - range.start + 1);
  headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
  return new Response(rangeStream, { status: 206, headers });
}
