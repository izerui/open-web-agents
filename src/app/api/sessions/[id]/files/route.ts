import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { canRenderInline } from "@/lib/modules/artifacts/domain/mime";
import { PathEscapeError } from "@/lib/modules/artifacts/domain/safe-path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  const url = new URL(req.url);
  const dir = url.searchParams.get("dir");
  const file = url.searchParams.get("file");
  const download = url.searchParams.get("download");
  const wantInline = url.searchParams.get("inline") !== null;

  try {
    if (download !== null) {
      const { bytes, mime } = await storage.read(session.workspaceDir, download);
      const filename = download.split("/").pop() ?? "download";

      /**
       * 内联渲染是【白名单】,不是开关。
       *
       * 请求里带了 inline 也只有图片放行:让浏览器在本站源下解析 agent 写出的
       * HTML,等于给它一个能读 cookie、发同源请求的执行环境。
       * 剩下的一律 attachment —— 浏览器会下载而不是执行。
       */
      const inline = wantInline && canRenderInline(mime);

      return new Response(new Uint8Array(bytes), {
        headers: {
          "Content-Type": mime,
          "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(filename)}"`,
          // 别让浏览器去猜类型 —— 猜错就可能把数据文件当 HTML 执行
          "X-Content-Type-Options": "nosniff",
          // SVG 能带脚本。sandbox 把它丢进独立源并禁脚本,直接访问链接也跑不起来
          "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
        },
      });
    }

    if (file !== null) {
      return Response.json({ preview: await storage.preview(session.workspaceDir, file) });
    }

    return Response.json({ nodes: await storage.tree(session.workspaceDir, dir ?? "") });
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
