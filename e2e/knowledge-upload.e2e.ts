// 知识库上传文件与检索测试(端到端):真实 multipart 上传 → 提取文字入库(过长自动切篇)→
// 检索测试命中 → 运行时确实把命中的片段带进了给模型的请求(假网关核对)。
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeGateway } from "../scripts/sdk-probe/fake-gateway.mjs";
import {
  docx,
  heavyDocx,
  pdf,
  pptxOrdered,
  xlsxWithGaps,
} from "../src/lib/modules/knowledge/adapters/__tests__/fixtures/make";
import { BASE, type Client, newUser, serverUp } from "./client";

const databaseUrl = process.env.OWA_E2E_DATABASE_URL;

type UploadResult = {
  results: (
    | {
        file: string;
        ok: true;
        format: string;
        docs: { id: string; title: string; chars: number }[];
      }
    | { file: string; ok: false; reason: string }
  )[];
};

async function upload(c: Client, agentId: string, files: { name: string; bytes: Uint8Array }[]) {
  const form = new FormData();
  for (const f of files) form.append("files", new Blob([f.bytes]), f.name);
  const res = await fetch(`${BASE}/api/agents/${agentId}/knowledge/upload`, {
    method: "POST",
    headers: { Cookie: c.cookieHeader() },
    body: form,
  });
  return { status: res.status, body: (await res.json()) as UploadResult & { error?: string } };
}

describe("知识库上传文件", () => {
  let owner: Client;
  let agentId = "";

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("server unavailable");
    owner = await newUser("kb-upload");
    const a = await owner.post<{ agent: { id: string } }>("/api/agents", {
      name: "资料助手",
      config: { systemPrompt: "按资料回答", model: "sonnet" },
    });
    agentId = a.body.agent.id;
  });

  it("多个文件:逐个结果;超长自动切篇;不支持的给原因、不影响其他", async () => {
    const long = `${"报销流程第一部分。".repeat(15_000)}\n\n${"报销流程第二部分。".repeat(10_000)}`;
    const r = await upload(owner, agentId, [
      {
        name: "差旅报销制度.docx",
        bytes: docx(["第一条 差旅住宿标准每晚不超过 450 元", "第二条 需附发票"]),
      },
      { name: "安全手册.pdf", bytes: pdf("实验室安全守则", { cjk: true }) },
      {
        name: "旧文件.doc",
        bytes: Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]),
      },
      { name: "长流程.txt", bytes: new TextEncoder().encode(long) },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const [word, pdfR, old, longR] = r.body.results;
    expect(word).toMatchObject({ ok: true, format: "docx", docs: [{ title: "差旅报销制度" }] });
    expect(pdfR).toMatchObject({ ok: true, format: "pdf", docs: [{ title: "安全手册" }] });
    expect(old).toMatchObject({ ok: false });
    expect(old?.ok === false && old.reason).toContain("另存为");
    expect(longR?.ok && longR.docs.map((d) => d.title)).toEqual(["长流程(1/2)", "长流程(2/2)"]);

    const list = await owner.get<{ docs: { title: string }[] }>(`/api/agents/${agentId}/knowledge`);
    expect(list.body.docs.map((d) => d.title).sort()).toEqual(
      ["差旅报销制度", "安全手册", "长流程(1/2)", "长流程(2/2)"].sort(),
    );
  });

  it("检索测试:命中片段与实际注入文本;没命中说明不带资料;别人看不到;只读者能测", async () => {
    const hit = await owner.post<{ hits: { docTitle: string; text: string }[]; context: string }>(
      `/api/agents/${agentId}/knowledge/search`,
      { query: "差旅住宿标准是多少" },
    );
    expect(hit.status).toBe(200);
    expect(hit.body.hits[0]).toMatchObject({ docTitle: "差旅报销制度" });
    expect(hit.body.context).toContain("450 元");
    const cjk = await owner.post<{ hits: { docTitle: string }[] }>(
      `/api/agents/${agentId}/knowledge/search`,
      { query: "实验室安全" },
    );
    expect(cjk.body.hits.map((h) => h.docTitle)).toContain("安全手册");
    const none = await owner.post<{ hits: unknown[]; context: string }>(
      `/api/agents/${agentId}/knowledge/search`,
      { query: "zzqqxx" },
    );
    expect(none.body).toEqual({ hits: [], context: "" });

    const stranger = await newUser("kb-stranger");
    expect(
      (await stranger.post(`/api/agents/${agentId}/knowledge/search`, { query: "差旅" })).status,
    ).toBe(404);
    expect(
      (await upload(stranger, agentId, [{ name: "a.txt", bytes: new TextEncoder().encode("x") }]))
        .status,
    ).toBe(404);
    const email = (await stranger.get<{ user: { email: string } }>("/api/auth")).body.user.email;
    expect(
      (await owner.post(`/api/agents/${agentId}/share`, { target: email, permission: "read" }))
        .status,
    ).toBe(201);
    expect(
      (await stranger.post(`/api/agents/${agentId}/knowledge/search`, { query: "差旅" })).status,
    ).toBe(200);
    // 只读不能上传
    expect(
      (await upload(stranger, agentId, [{ name: "a.txt", bytes: new TextEncoder().encode("x") }]))
        .status,
    ).toBe(403);
  });

  it("PPT 拖动过页面:入库正文与页码按展示顺序,不按文件编号", async () => {
    const r = await upload(owner, agentId, [
      {
        name: "调整过顺序的课件.pptx",
        bytes: pptxOrdered([["第一讲 绪论"], ["第二讲 方法"]], [2, 1]),
      },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const saved = r.body.results[0];
    const docId = saved?.ok ? saved.docs[0]?.id : undefined;
    const doc = await owner.get<{ content: string }>(`/api/agents/${agentId}/knowledge/${docId}`);
    expect(doc.body.content).toBe("第 1 页\n第二讲 方法\n\n第 2 页\n第一讲 绪论");
  });

  it("PPT 顺序表中间一页的引用缺失:上传失败并说明,不入库(不跳过后把后面的页码错位)", async () => {
    const before = await owner.get<{ docs: { title: string }[] }>(
      `/api/agents/${agentId}/knowledge`,
    );
    const r = await upload(owner, agentId, [
      {
        name: "缺一页的课件.pptx",
        bytes: pptxOrdered([["第一讲"], ["第二讲"], ["第三讲"]], [1, 2, 3], { missingRel: 2 }),
      },
    ]);
    expect(r.status).toBe(400);
    expect(r.body.results[0]).toMatchObject({ ok: false });
    const failed = r.body.results[0];
    expect(failed?.ok === false && failed.reason).toContain("第 2 页");
    const after = await owner.get<{ docs: { title: string }[] }>(
      `/api/agents/${agentId}/knowledge`,
    );
    expect(after.body.docs.map((d) => d.title).sort()).toEqual(
      before.body.docs.map((d) => d.title).sort(),
    );
  });

  it("Excel 空单元格按列对齐:缺 B2 时 C2 仍在第 3 列(数学)", async () => {
    const r = await upload(owner, agentId, [{ name: "成绩表.xlsx", bytes: xlsxWithGaps() }]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const saved = r.body.results[0];
    const docId = saved?.ok ? saved.docs[0]?.id : undefined;
    const doc = await owner.get<{ content: string }>(`/api/agents/${agentId}/knowledge/${docId}`);
    expect(doc.body.content.split("\n")[2]).toBe("张三\t\t95");
  });

  it("解析很重的文件时,服务照常响应其他请求;之后的上传照常处理", { timeout: 120_000 }, async () => {
    let done = false;
    const heavy = upload(owner, agentId, [{ name: "很大.docx", bytes: heavyDocx() }]).finally(
      () => {
        done = true;
      },
    );
    const latencies: number[] = [];
    while (!done) {
      const t = Date.now();
      const h = await fetch(`${BASE}/api/health?probe=live`);
      expect(h.ok).toBe(true);
      latencies.push(Date.now() - t);
      await new Promise((r) => setTimeout(r, 50));
    }
    const r = await heavy;
    // 解析出的文字超过知识库总上限:给出原因而不是超时或崩溃
    expect(r.body.results[0]).toMatchObject({ ok: false });
    expect(latencies.length).toBeGreaterThan(3);
    expect(Math.max(...latencies)).toBeLessThan(1_000);
    const after = await upload(owner, agentId, [
      { name: "之后.docx", bytes: docx(["解析重文件之后照常"]) },
    ]);
    expect(after.body.results[0]).toMatchObject({ ok: true });
  });

  it(
    "不带 Content-Length 的分块上传、实际超过 100MB:读到上限就停止读取、返回 413,不入库",
    { timeout: 120_000 },
    async () => {
      const before = await owner.get<{ docs: unknown[] }>(`/api/agents/${agentId}/knowledge`);
      const boundary = "----owa-stream-test";
      const head = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="巨大.txt"\r\nContent-Type: text/plain\r\n\r\n`,
      );
      const chunk = Buffer.alloc(1024 * 1024, "a");
      const LIMIT = 300 * 1024 * 1024;
      const url = new URL(`/api/agents/${agentId}/knowledge/upload`, BASE);
      const outcome = await new Promise<{ status: number; written: number; body: string }>(
        (resolve, reject) => {
          let written = 0;
          let responded = false;
          const req = http.request(url, {
            method: "POST",
            headers: {
              Cookie: owner.cookieHeader(),
              "Content-Type": `multipart/form-data; boundary=${boundary}`,
              // 不设 Content-Length:node:http 用分块传输
              "Transfer-Encoding": "chunked",
            },
          });
          req.on("response", (res) => {
            responded = true;
            const at = written;
            let body = "";
            res.on("data", (d) => {
              body += d;
            });
            res.on("end", () => {
              resolve({ status: res.statusCode ?? 0, written: at, body });
              req.destroy();
            });
          });
          req.on("error", (err) => {
            if (!responded) reject(err);
          });
          req.write(head);
          const pump = () => {
            while (!responded && written < LIMIT) {
              written += chunk.length;
              if (!req.write(chunk)) {
                req.once("drain", pump);
                return;
              }
            }
            if (!responded) req.end(`\r\n--${boundary}--\r\n`);
          };
          pump();
        },
      );
      expect(outcome.status, outcome.body).toBe(413);
      expect(outcome.body).toContain("100MB");
      // 服务端读到上限就停了:回应时客户端远没写完 300MB(写不进去只能停在缓冲区)
      expect(outcome.written).toBeLessThan(160 * 1024 * 1024);
      const after = await owner.get<{ docs: unknown[] }>(`/api/agents/${agentId}/knowledge`);
      expect(after.body.docs).toHaveLength(before.body.docs.length);
    },
  );

  it("单个文件超过 20MB:不读内容就判失败,同批其他文件照常", async () => {
    const r = await upload(owner, agentId, [
      { name: "超大.txt", bytes: new Uint8Array(21 * 1024 * 1024).fill(97) },
      { name: "正常.txt", bytes: new TextEncoder().encode("同批的小文件") },
    ]);
    expect(r.status).toBe(201);
    expect(r.body.results[0]).toMatchObject({ ok: false });
    const big = r.body.results[0];
    expect(big?.ok === false && big.reason).toContain("20MB");
    expect(r.body.results[1]).toMatchObject({ ok: true });
  });

  it("参数:没有文件、超过 20 个文件 400", async () => {
    expect((await upload(owner, agentId, [])).status).toBe(400);
    const many = Array.from({ length: 21 }, (_, i) => ({
      name: `${i}.txt`,
      bytes: new TextEncoder().encode("x"),
    }));
    expect((await upload(owner, agentId, many)).status).toBe(400);
  });
});

describe.skipIf(!databaseUrl)("知识库上传文件:运行时带入", () => {
  let gw: Awaited<ReturnType<typeof startFakeGateway>>;
  let admin: Client;
  let promotedId: string | undefined;

  async function db() {
    const { createConnection } = await import("mysql2/promise");
    return createConnection(databaseUrl as string);
  }

  beforeAll(async () => {
    gw = await startFakeGateway([{ text: "按资料回答完毕。" }]);
    admin = await newUser("kb-runtime");
    const me = await admin.get<{ user: { id: string; role: string } }>("/api/auth");
    if (me.body.user.role !== "admin") {
      promotedId = me.body.user.id;
      const c = await db();
      await c.execute("UPDATE users SET role = 'admin' WHERE id = ?", [promotedId]);
      await c.end();
    }
  });
  afterAll(async () => {
    gw?.close();
    if (promotedId) {
      const c = await db();
      await c.execute("UPDATE users SET role = 'user' WHERE id = ?", [promotedId]);
      await c.end();
    }
  });

  it("上传的 Word 被检索命中后,运行时出现在给模型的请求里", { timeout: 60_000 }, async () => {
    const tag = Date.now();
    const p = await admin.post<{ provider: { id: string } }>("/api/admin/providers", {
      definition: {
        name: `知识库测试-${tag}`,
        enabled: true,
        endpoints: { llm: { protocol: "anthropic", baseUrl: gw.baseUrl } },
      },
      apiKey: `sk-kb-${tag}`,
    });
    const m = await admin.post<{ model: { id: string } }>("/api/admin/models", {
      expectedVersion: null,
      definition: {
        name: `知识库模型-${tag}`,
        kind: "llm",
        modelId: `kb-${tag}`,
        enabled: true,
        acceptsImages: false,
        providerId: p.body.provider.id,
        markupBp: 0,
        costRates: [
          { meter: "input_token", units: "1000000", microCredits: "1000000" },
          { meter: "output_token", units: "1000000", microCredits: "1000000" },
          { meter: "cache_read_token", units: "1000000", microCredits: "0" },
          { meter: "cache_write_token", units: "1000000", microCredits: "0" },
        ],
        rates: [],
      },
    });
    expect(m.status, JSON.stringify(m.body)).toBe(201);
    const a = await admin.post<{ agent: { id: string } }>("/api/agents", {
      name: `资料-${tag}`,
      config: { systemPrompt: "按资料回答", model: m.body.model.id, maxTurns: 2 },
    });
    const agentId = a.body.agent.id;
    const up = await upload(admin, agentId, [
      { name: "门禁规定.docx", bytes: docx(["门禁卡挂失请到行政楼 302 室办理"]) },
    ]);
    expect(up.status).toBe(201);
    const s = await admin.post<{ session: { id: string } }>("/api/sessions", { agentId });
    const run = await admin.post<{ status?: string }>(`/api/sessions/${s.body.session.id}/run`, {
      prompt: "门禁卡挂失去哪里办",
      stream: false,
    });
    expect(run.body.status, JSON.stringify(run.body)).toBe("success");
    expect(JSON.stringify(gw.seenRequests)).toContain("行政楼 302 室");
  });
});
