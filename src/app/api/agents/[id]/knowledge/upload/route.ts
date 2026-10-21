import { randomUUID } from "node:crypto";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { EXTRACT_LIMITS, extractText } from "@/lib/modules/knowledge/adapters/extract-text";
import { KNOWLEDGE_LIMITS, KnowledgeLimitExceeded } from "@/lib/modules/knowledge/domain/limits";
import { splitDoc, titleOf } from "@/lib/modules/knowledge/domain/split-doc";
import { requirePermission } from "../_lib/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 一次最多传几个文件、整个请求最大多少:解析在 web 进程里做,要有界 */
const MAX_FILES = 20;
const MAX_REQUEST_BYTES = 100 * 1024 * 1024;

/**
 * 边读边数请求体,超过上限立刻停止读取。返回读到的全部字节,超限返回 null。
 * 【不能只看 Content-Length】分块传输的请求不带这个头,按 0 放过后 formData() 会把整份请求读进内存
 */
async function readBounded(req: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!req.body) return new Uint8Array(new ArrayBuffer(0));
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(new ArrayBuffer(total));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

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

    const tooLarge = () =>
      Response.json(
        { error: `一次上传合计不能超过 ${MAX_REQUEST_BYTES / 1024 / 1024}MB,请分批上传` },
        { status: 413 },
      );
    // 声明了长度且已超:一个字节都不读
    if (Number(req.headers.get("content-length") ?? 0) > MAX_REQUEST_BYTES) return tooLarge();
    // 没声明长度(分块传输)或声明的不可信:边读边数,超了立刻停
    const body = await readBounded(req, MAX_REQUEST_BYTES);
    if (!body) return tooLarge();
    let form: FormData;
    try {
      form = await new Response(body, {
        headers: { "content-type": req.headers.get("content-type") ?? "" },
      }).formData();
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
      // 先看大小再读内容:超过单文件上限的不转成数组
      if (f.size > EXTRACT_LIMITS.maxBytes) {
        results.push({
          file: name,
          ok: false,
          reason: `文件超过 ${Math.round(EXTRACT_LIMITS.maxBytes / 1024 / 1024)}MB 上限`,
        });
        continue;
      }
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
