// 上传接口的整体保护:一次上传的总时长用完后剩下的文件不解析不入库;客户端断开后停止;
// 同时处理的上传请求有上限,超了在读请求体之前就拒绝,处理完名额归还。
// 解析与入库用替身,路由逻辑是真的。
import { UPLOAD_LIMITS } from "@/lib/modules/knowledge/application/upload-limits";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createMany = vi.fn(async (_agentId: string, docs: { id: string; title: string }[]) => docs);
const extractText = vi.fn();
vi.mock("@/lib/container", () => ({
  getContainer: () => ({ knowledge: { createMany }, audit: { record: async () => {} } }),
}));
vi.mock("../../_lib/access", () => ({
  requirePermission: async () => ({ agent: { id: "a1", ownerId: "u1" }, principal: {} }),
}));
vi.mock("@/lib/modules/knowledge/adapters/extract-text", async (orig) => ({
  ...(await orig<typeof import("@/lib/modules/knowledge/adapters/extract-text")>()),
  extractText: (...args: unknown[]) => extractText(...args),
}));
import { POST } from "../route";

const saved = { ...UPLOAD_LIMITS };
beforeEach(() => {
  createMany.mockClear();
  extractText.mockReset();
});
afterEach(() => Object.assign(UPLOAD_LIMITS, saved));

function request(names: string[], signal?: AbortSignal) {
  const form = new FormData();
  for (const n of names) form.append("files", new Blob(["x"]), n);
  return new Request("http://x/api/agents/a1/knowledge/upload", {
    method: "POST",
    body: form,
    signal,
  });
}
const call = (req: Request) => POST(req, { params: Promise.resolve({ id: "a1" }) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const okText = { ok: true, format: "text", text: "内容" };

describe("知识库上传:总时长、断开、并发", () => {
  it("总时长用完:剩下的文件标为未处理,不解析不入库;单个文件的解析时限不超过剩余时间", async () => {
    UPLOAD_LIMITS.budgetMs = 1_500;
    extractText.mockImplementation(async () => {
      await sleep(700);
      return okText;
    });
    const res = await call(request(["一.txt", "二.txt", "三.txt"]));
    const body = (await res.json()) as { results: { ok: boolean; reason?: string }[] };
    expect(res.status).toBe(201);
    expect(body.results[0]).toMatchObject({ ok: true });
    for (const r of body.results.slice(1)) {
      expect(r).toMatchObject({ ok: false });
      expect(r.reason).toContain("处理时间已用完");
    }
    expect(extractText).toHaveBeenCalledTimes(1);
    expect((extractText.mock.calls[0]?.[2] as { timeoutMs: number }).timeoutMs).toBeLessThanOrEqual(
      1_500,
    );
    expect(createMany).toHaveBeenCalledTimes(1);
  });

  it("客户端断开:之后的文件不再处理", async () => {
    const ac = new AbortController();
    extractText.mockImplementation(async () => {
      ac.abort();
      return okText;
    });
    const res = await call(request(["一.txt", "二.txt"], ac.signal));
    const body = (await res.json()) as { results: { ok: boolean; reason?: string }[] };
    expect(body.results[1]?.reason).toContain("连接已断开");
    expect(extractText).toHaveBeenCalledTimes(1);
  });

  it("同时处理的上传有上限:超了在读请求体之前就 503,处理完名额归还", async () => {
    UPLOAD_LIMITS.maxInflight = 2;
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    extractText.mockImplementation(async () => {
      await gate;
      return okText;
    });
    const first = call(request(["一.txt"]));
    const second = call(request(["二.txt"]));
    await sleep(50);
    // 第三个:请求体一个字节都不读
    let pulled = false;
    // highWaterMark 0:流不会预读,只有真的被读取才会调用 pull
    const body = new ReadableStream(
      {
        pull(c) {
          pulled = true;
          c.close();
        },
      },
      { highWaterMark: 0 },
    );
    const third = await call(
      new Request("http://x/api/agents/a1/knowledge/upload", {
        method: "POST",
        body,
        duplex: "half",
        headers: { "content-type": "multipart/form-data; boundary=x" },
      } as RequestInit),
    );
    expect(third.status).toBe(503);
    expect(third.headers.get("Retry-After")).toBe("10");
    expect(pulled).toBe(false);
    release();
    expect((await first).status).toBe(201);
    expect((await second).status).toBe(201);
    // 名额归还:之后照常
    expect((await call(request(["四.txt"]))).status).toBe(201);
  });
});
