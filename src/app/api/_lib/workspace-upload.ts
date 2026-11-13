import fs from "node:fs/promises";
import { PathEscapeError, resolveInWorkspace } from "@/lib/modules/artifacts/domain/safe-path";
import type { StoragePort } from "@/lib/modules/artifacts/ports";
import type { SessionRepo } from "@/lib/modules/session/ports";

const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" };

/** 单个附件上限(对话页与设计器一致) */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** 一次最多上传几个 */
export const MAX_UPLOAD_FILES = 20;

/**
 * 把表单里的 files 写进会话工作目录(对话页附件、设计器附件共用)。调用方先做完归属校验。
 *
 * - 整批先校验(大小、重名、越界、保留名)再写,避免写了一半失败留下残留文件
 * - 默认只新建;overwrite=true 才覆盖同名文件
 * - reserved:不允许上传的文件名(如设计草稿),命中 409
 */
export async function uploadToWorkspace(
  req: Request,
  target: { sessionId: string; workspaceDir: string },
  deps: { sessions: Pick<SessionRepo, "prepareWorkspace">; storage: Pick<StoragePort, "write"> },
  opts: { overwrite?: boolean; reserved?: readonly string[] } = {},
): Promise<Response> {
  const form = await req.formData().catch(() => null);
  const files = form?.getAll("files").filter((value): value is File => value instanceof File) ?? [];
  if (files.length === 0) return Response.json({ error: "files are required" }, { status: 400 });
  if (files.length > MAX_UPLOAD_FILES)
    return Response.json({ error: "too many files" }, { status: 413 });

  const names = new Set<string>();
  try {
    // 先把整批可预见错误验完，再开始写。否则第 1 个文件已经落盘，
    // 第 2 个才因过大、重名或越界失败，用户重试时又会撞上残留文件。
    for (const file of files) {
      if (file.size > MAX_UPLOAD_BYTES) {
        return Response.json({ error: `file too large: ${file.name}` }, { status: 413 });
      }
      if (names.has(file.name)) {
        return Response.json({ error: `duplicate file name: ${file.name}` }, { status: 409 });
      }
      names.add(file.name);
      resolveInWorkspace(target.workspaceDir, file.name);
      if (opts.reserved?.includes(file.name.replace(/^\.\//, ""))) {
        return Response.json(
          { error: `文件名 ${file.name} 已被占用，请改个名字再上传` },
          { status: 409 },
        );
      }
    }

    const prepared = await Promise.all(
      files.map(async (file) => ({ file, bytes: Buffer.from(await file.arrayBuffer()) })),
    );
    /*
     * 写之前先走工作目录协议:在会话行锁内记下"刚用过"并确保目录存在。
     * 上传不产生运行 —— 不记这一笔,GC 只看运行时间,长期未活动的会话里刚上传的文件
     * 可能马上被清掉;GC 正在改名挪走目录时,这里会等它挪完再建新目录。
     */
    await deps.sessions.prepareWorkspace(target.sessionId, { nowMs: Date.now() }, async () => {
      await fs.mkdir(target.workspaceDir, { recursive: true });
    });
    const uploaded: string[] = [];
    for (const { file, bytes } of prepared) {
      await deps.storage.write(target.workspaceDir, file.name, bytes, {
        overwrite: opts.overwrite === true,
      });
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
