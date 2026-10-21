import { randomUUID } from "node:crypto";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { extractText } from "@/lib/modules/knowledge/adapters/extract-text";
import { KNOWLEDGE_LIMITS, KnowledgeLimitExceeded } from "@/lib/modules/knowledge/domain/limits";
import { splitDoc, titleOf } from "@/lib/modules/knowledge/domain/split-doc";
import { requirePermission } from "../_lib/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 一次最多传几个文件、整个请求最大多少:解析在 web 进程里做,要有界 */
const MAX_FILES = 20;
const MAX_REQUEST_BYTES = 100 * 1024 * 1024;

type FileResult =
  | {
      file: string;
      ok: true;
      format: string;
      pages?: number;
      docs: { id: string; title: string; chars: number }[];
    }
  | { file: string; ok: false; reason: string };

/**
 * 上传文件到知识库(multipart,字段名 files,可多个)。
 * 每个文件提取文字后存成一篇文档(超过单篇上限就按顺序切成几篇,要么都进要么都不进);
 * 逐个返回结果,一个失败不影响其他。只存提取出的文字,不存原文件。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { knowledge, audit } = getContainer();
  try {
    const r = await requirePermission(req, id, "write");
    if (r.error) return r.error;

    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_REQUEST_BYTES) {
      return Response.json(
        { error: `一次上传合计不能超过 ${MAX_REQUEST_BYTES / 1024 / 1024}MB,请分批上传` },
        { status: 413 },
      );
    }
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return Response.json(
        { error: "请用 multipart/form-data 上传,字段名 files" },
        { status: 400 },
      );
    }
    const files = form.getAll("files").filter((f): f is File => f instanceof File);
    if (files.length === 0) return Response.json({ error: "没有收到文件" }, { status: 400 });
    if (files.length > MAX_FILES) {
      return Response.json({ error: `一次最多上传 ${MAX_FILES} 个文件` }, { status: 400 });
    }

    const results: FileResult[] = [];
    // 逐个处理:解析占 CPU,并发只会让每个都更慢;也让容量上限按顺序判定
    for (const f of files) {
      const name = f.name || "未命名文件";
      const got = await extractText(name, new Uint8Array(await f.arrayBuffer()));
      if (!got.ok) {
        results.push({ file: name, ok: false, reason: got.reason });
        continue;
      }
      const parts = splitDoc(titleOf(name), got.text, KNOWLEDGE_LIMITS.maxDocChars);
      try {
        const docs = await knowledge.createMany(
          id,
          parts.map((p) => ({
            id: randomUUID().replace(/-/g, "").slice(0, 24),
            agentId: id,
            title: p.title,
            content: p.content,
          })),
        );
        const saved = docs.map((d, i) => ({
          id: d.id,
          title: d.title,
          chars: [...(parts[i]?.content ?? "")].length,
        }));
        results.push({
          file: name,
          ok: true,
          format: got.format,
          ...(got.pages !== undefined ? { pages: got.pages } : {}),
          docs: saved,
        });
        await audit.record({
          actor: r.principal,
          action: "knowledge.add",
          resource: { type: "agent", id },
          ownerId: r.agent.ownerId,
          details: {
            upload: true,
            file: name,
            format: got.format,
            docIds: saved.map((d) => d.id),
            chars: saved.reduce((n, d) => n + d.chars, 0),
          },
          req,
        });
      } catch (err) {
        if (err instanceof KnowledgeLimitExceeded) {
          results.push({ file: name, ok: false, reason: err.message });
          continue;
        }
        throw err;
      }
    }
    const status = results.some((x) => x.ok) ? 201 : 400;
    return Response.json({ results }, { status });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
