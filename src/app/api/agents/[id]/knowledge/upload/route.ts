import { randomUUID } from "node:crypto";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { EXTRACT_LIMITS, extractText } from "@/lib/modules/knowledge/adapters/extract-text";
import { UPLOAD_LIMITS } from "@/lib/modules/knowledge/application/upload-limits";
import {
  KNOWLEDGE_LIMITS,
  KnowledgeLimitExceeded,
  KnowledgeWriteAborted,
  KnowledgeWriteUncertain,
} from "@/lib/modules/knowledge/domain/limits";
import { splitDoc, titleOf } from "@/lib/modules/knowledge/domain/split-doc";
import { requirePermission } from "../_lib/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 本进程里正在处理的上传请求数(见 UPLOAD_LIMITS.maxInflight) */
let inflight = 0;

/**
 * 取消读取:发起后不等它结束。底层流的 cancel() 可能永远不返回(实测 Node 的 ReadableStream 会这样),
 * 等它的话路由卡在这里,上传名额也就释放不了;取消里的异常也接住,不影响返回
 */
function stopReading(reader: ReadableStreamDefaultReader<Uint8Array>) {
  try {
    void reader.cancel().catch(() => {});
  } catch {
    // 取消本身同步抛错:读取已经停了,不影响返回
  }
}

/**
 * 边读边数请求体,超过上限立刻停止读取;到点(deadline)或客户端断开也立刻停止。
 * 【不能只看 Content-Length】分块传输的请求不带这个头,按 0 放过后 formData() 会把整份请求读进内存。
 * 【读取本身也要有时限】客户端慢慢传、始终不结束,reader.read() 会一直等,上传名额就一直被占着
 */
async function readBounded(
  req: Request,
  max: number,
  deadline: number,
): Promise<
  | { ok: true; bytes: Uint8Array<ArrayBuffer> }
  | { ok: false; why: "too_large" | "timeout" | "aborted" }
> {
  if (!req.body) return { ok: true, bytes: new Uint8Array(new ArrayBuffer(0)) };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  // 到点或断开时让正在等的 read() 立刻有结果
  const stop = new Promise<"timeout" | "aborted">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), Math.max(0, deadline - Date.now()));
    onAbort = () => resolve("aborted");
    if (req.signal.aborted) onAbort();
    else req.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), stop]);
      if (next === "timeout" || next === "aborted") {
        stopReading(reader);
        return { ok: false, why: next };
      }
      if (next.done) break;
      total += next.value.byteLength;
      if (total > max) {
        stopReading(reader);
        return { ok: false, why: "too_large" };
      }
      chunks.push(next.value);
    }
  } finally {
    clearTimeout(timer);
    if (onAbort) req.signal.removeEventListener("abort", onAbort);
  }
  const out = new Uint8Array(new ArrayBuffer(total));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return { ok: true, bytes: out };
}

type FileResult =
  | {
      file: string;
      ok: true;
      format: string;
      pages?: number;
      docs: { id: string; title: string; chars: number }[];
    }
  | { file: string; ok: false; reason: string; uncertain?: true };

/**
 * 上传文件到知识库(multipart,字段名 files,可多个)。
 * 每个文件提取文字后存成一篇文档(超过单篇上限就按顺序切成几篇,要么都进要么都不进);
 * 逐个返回结果,一个失败不影响其他。只存提取出的文字,不存原文件。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { knowledge, audit } = getContainer();
  let counted = false;
  try {
    const r = await requirePermission(req, id, "write");
    if (r.error) return r.error;

    const { maxFiles: MAX_FILES, maxRequestBytes: MAX_REQUEST_BYTES, budgetMs } = UPLOAD_LIMITS;
    // 同时处理的上传请求有上限:每个都要在内存里缓冲请求体。读请求体之前就拒绝
    if (inflight >= UPLOAD_LIMITS.maxInflight) {
      return Response.json(
        { error: "当前上传的人较多,请稍后再试" },
        { status: 503, headers: { "Retry-After": "10" } },
      );
    }
    inflight++;
    counted = true;
    const deadline = Date.now() + budgetMs;

    const tooLarge = () =>
      Response.json(
        { error: `一次上传合计不能超过 ${MAX_REQUEST_BYTES / 1024 / 1024}MB,请分批上传` },
        { status: 413 },
      );
    // 声明了长度且已超:一个字节都不读
    if (Number(req.headers.get("content-length") ?? 0) > MAX_REQUEST_BYTES) return tooLarge();
    // 没声明长度(分块传输)或声明的不可信:边读边数,超了、到点、断开都立刻停
    const read = await readBounded(req, MAX_REQUEST_BYTES, deadline);
    if (!read.ok) {
      if (read.why === "too_large") return tooLarge();
      return Response.json(
        {
          error:
            read.why === "timeout"
              ? `上传在 ${Math.round(budgetMs / 1000)} 秒内没有传完,已停止接收;请检查网络或分批上传`
              : "上传连接已断开",
        },
        { status: 408 },
      );
    }
    let form: FormData;
    try {
      form = await new Response(read.bytes, {
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
      // 总时长用完、或客户端已经断开:剩下的不解析不入库,如实标出
      const remaining = deadline - Date.now();
      if (req.signal.aborted || remaining < 1_000) {
        results.push({
          file: name,
          ok: false,
          reason: req.signal.aborted
            ? "上传连接已断开,这个文件没有处理"
            : `本次上传处理时间已用完(上限 ${Math.round(budgetMs / 1000)} 秒),这个文件没有处理;请分批上传`,
        });
        continue;
      }
      // 先看大小再读内容:超过单文件上限的不转成数组
      if (f.size > EXTRACT_LIMITS.maxBytes) {
        results.push({
          file: name,
          ok: false,
          reason: `文件超过 ${Math.round(EXTRACT_LIMITS.maxBytes / 1024 / 1024)}MB 上限`,
        });
        continue;
      }
      const got = await extractText(
        name,
        new Uint8Array(await f.arrayBuffer()),
        // 单个文件的解析时限不超过本次上传剩下的时间
        { ...EXTRACT_LIMITS, timeoutMs: Math.min(EXTRACT_LIMITS.timeoutMs, remaining) },
        // 客户端断开:排队的撤出、正在跑的解析子进程立刻杀掉
        req.signal,
      );
      // 解析期间断开或时间用完:解析成功了也不入库 —— 否则用户看到失败,服务端却存进去了
      if (req.signal.aborted || Date.now() > deadline) {
        results.push({
          file: name,
          ok: false,
          reason: req.signal.aborted
            ? "上传连接已断开,这个文件没有入库"
            : `本次上传处理时间已用完(上限 ${Math.round(budgetMs / 1000)} 秒),这个文件没有入库;请分批上传`,
        });
        continue;
      }
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
          // 期限与取消一直传进事务:等锁期间超时或断开,锁释放后也不会插入提交
          { deadline, signal: req.signal },
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
        if (err instanceof KnowledgeWriteUncertain) {
          // 提交已经发出,结果没拿到:可能已入库。不能说"没有入库"(据此重传会重复导入)
          results.push({
            file: name,
            ok: false,
            uncertain: true,
            reason: "无法确认是否入库,请刷新知识库核对后再决定是否重传",
          });
          continue;
        }
        if (err instanceof KnowledgeWriteAborted) {
          results.push({
            file: name,
            ok: false,
            reason:
              err.why === "aborted"
                ? "上传连接已断开,这个文件没有入库"
                : `本次上传处理时间已用完(上限 ${Math.round(budgetMs / 1000)} 秒),这个文件没有入库;请分批上传`,
          });
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
  } finally {
    if (counted) inflight--;
  }
}
