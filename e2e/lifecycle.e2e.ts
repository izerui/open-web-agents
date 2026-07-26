// 运行生命周期与运维接口的端到端回归。
//
// 覆盖的是"不需要真的调模型就能验"的那部分:健康探针、会话隔离、取消、
// 工作空间路径守卫。真正跑 agent 的那些(串台、优雅关停)要多进程 + 真实网关,
// 不适合放进这条快路径 —— 文件末尾如实列出了没覆盖什么。

import { beforeAll, describe, expect, it } from "vitest";
import { BASE, type Client, newUser, serverUp } from "./client";

type SessionRes = { session?: { id: string } };
type ListRes = { assistants?: { id: string }[] };
type BranchRes = { runs?: { id: string; status: string }[] };
type CancelRes = { cancelled?: string[]; note?: string };
type HealthRes = {
  status: string;
  checks?: { database?: { ok: boolean }; redis?: { ok: boolean }; worker?: { ok: boolean } };
  config?: Record<string, unknown>;
};

describe("健康探针", () => {
  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
  });

  it("存活探针不碰任何依赖", async () => {
    const r = await fetch(`${BASE}/api/health?probe=live`);
    expect(r.status).toBe(200);
    const b = (await r.json()) as { status: string };
    // 只回存活信息,不含 checks —— 数据库挂了不等于进程该死
    expect(b.status).toBe("alive");
    expect(b).not.toHaveProperty("checks");
  });

  it("就绪探针报告各依赖,且包含 worker", async () => {
    const r = await fetch(`${BASE}/api/health`);
    const b = (await r.json()) as HealthRes;
    expect(b.checks?.database?.ok).toBe(true);
    expect(b.checks?.redis?.ok).toBe(true);
    // worker 假死时光探 SELECT 1 看不出来,必须单独报
    expect(b.checks?.worker).toBeDefined();
    expect(r.status).toBe(b.status === "ready" ? 200 : 503);
  });

  it("健康响应里不含任何密钥", async () => {
    const text = await (await fetch(`${BASE}/api/health`)).text();
    expect(text).not.toMatch(/SECRET|sk-|password|mysql:\/\//i);
  });
});

describe("会话归属隔离", () => {
  let a: Client;
  let b: Client;
  let sessionId: string;

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
    a = await newUser("sess-a");
    b = await newUser("sess-b");
    const list = await a.get<ListRes>("/api/assistants");
    const assistantId = list.body.assistants?.[0]?.id;
    expect(assistantId).toBeTruthy();
    const s = await a.post<SessionRes>("/api/sessions", { assistantId });
    sessionId = s.body.session?.id ?? "";
    expect(sessionId).toBeTruthy();
  });

  it("自己的会话在列表里", async () => {
    const r = await a.get<{ sessions?: { id: string }[] }>("/api/sessions");
    expect((r.body.sessions ?? []).map((s) => s.id)).toContain(sessionId);
  });

  it("别人的会话不在列表里", async () => {
    const r = await b.get<{ sessions?: { id: string }[] }>("/api/sessions");
    expect((r.body.sessions ?? []).map((s) => s.id)).not.toContain(sessionId);
  });

  for (const path of ["files", "approvals", "branch"] as const) {
    it(`别人读不到 /sessions/{id}/${path}`, async () => {
      const r = await b.get(`/api/sessions/${sessionId}/${path}`);
      expect(r.status).toBeGreaterThanOrEqual(400);
    });
  }

  it("别人发不起运行", async () => {
    const r = await b.post(`/api/sessions/${sessionId}/run`, { prompt: "hi" });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it("别人取消不了", async () => {
    const r = await b.post(`/api/sessions/${sessionId}/cancel`);
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
});

describe("工作空间路径守卫", () => {
  let a: Client;
  let sessionId: string;

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
    a = await newUser("fs");
    const list = await a.get<ListRes>("/api/assistants");
    const s = await a.post<SessionRes>("/api/sessions", {
      assistantId: list.body.assistants?.[0]?.id,
    });
    sessionId = s.body.session?.id ?? "";
  });

  it("列自己的工作空间正常", async () => {
    const r = await a.get(`/api/sessions/${sessionId}/files`);
    expect(r.status).toBe(200);
  });

  // 三个入口(列目录 / 预览 / 下载)各自都要挡 —— 只测一个等于没测,
  // 真实的穿越会挑最少人看的那个入口进。
  const EVIL = [
    "../",
    "../../",
    "../../../etc/passwd",
    "..%2F..%2Fetc%2Fpasswd",
    "/etc/passwd",
    "./../../etc/hosts",
    "..\\..\\windows\\win.ini",
  ];

  for (const param of ["dir", "file", "download"] as const) {
    for (const evil of EVIL) {
      it(`${param}=${evil} 被拒`, async () => {
        const r = await a.get(
          `/api/sessions/${sessionId}/files?${param}=${encodeURIComponent(evil)}`,
        );
        expect(r.status).toBeGreaterThanOrEqual(400);
        // 就算状态码将来被改动,也不能真的把宿主文件内容回出去
        expect(JSON.stringify(r.body)).not.toMatch(/root:x:|127\.0\.0\.1|\[fonts\]/);
      });
    }
  }
});

describe("取消", () => {
  let a: Client;
  let sessionId: string;

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
    a = await newUser("cancel");
    const list = await a.get<ListRes>("/api/assistants");
    const s = await a.post<SessionRes>("/api/sessions", {
      assistantId: list.body.assistants?.[0]?.id,
    });
    sessionId = s.body.session?.id ?? "";
  });

  it("没有在跑的运行时,如实说明而不是假装取消了什么", async () => {
    const r = await a.post<CancelRes>(`/api/sessions/${sessionId}/cancel`);
    expect(r.status).toBe(200);
    expect(r.body.cancelled).toEqual([]);
    expect(r.body.note).toMatch(/没有可取消/);
  });

  it("取消接口存在且如实告知延迟 —— 界面不该在点下去的瞬间就说已停止", async () => {
    // 发起一轮但不等它跑完(流会一直挂着,这里只要它入队)
    const ac = new AbortController();
    void fetch(`${BASE}/api/sessions/${sessionId}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: a.cookieHeader() },
      body: JSON.stringify({ prompt: "数到 100" }),
      signal: ac.signal,
    }).catch(() => {});

    // 等它进队列
    await new Promise((r) => setTimeout(r, 1500));
    const runs = await a.get<BranchRes>(`/api/sessions/${sessionId}/branch`);
    const live = (runs.body.runs ?? []).filter(
      (r) => r.status === "pending" || r.status === "running",
    );

    if (live.length === 0) {
      // 没抓到在跑的运行(模型太快或没配网关),不硬凑 —— 上面那条已覆盖接口契约
      ac.abort();
      return;
    }

    const c = await a.post<CancelRes>(`/api/sessions/${sessionId}/cancel`);
    expect(c.body.cancelled?.length).toBeGreaterThan(0);
    expect(c.body.note).toMatch(/15 秒|心跳/);
    ac.abort();

    // 最多一个心跳周期后应落 cancelled(worker 侧默认心跳 15s)
    const deadline = Date.now() + 25_000;
    let final = "";
    while (Date.now() < deadline) {
      const r = await a.get<BranchRes>(`/api/sessions/${sessionId}/branch`);
      const target = (r.body.runs ?? []).find((x) => x.id === live[0]?.id);
      final = target?.status ?? "";
      if (final !== "pending" && final !== "running") break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    // 不能还停在 running —— 那就是"点了停止其实没停"
    expect(["cancelled", "failed", "success"]).toContain(final);
  }, 40_000);
});

// ── 这条快路径【没有】覆盖的,如实记在这里,免得被误读成"全都测了" ──
//
// 1. 同会话并发串台:要 2 个以上 worker 才有真并发,且要真的调模型。
//    已在 replay-buffer 单测里覆盖分桶逻辑,端到端只做过一次手工验证。
// 2. 优雅关停:要向独立 worker 进程发 SIGTERM 并观察在途任务落终态,
//    需要多进程编排。已在 worker.drain 的单测里覆盖,端到端做过一次手工验证。
// 3. Redis 断连时的 unknown 降级:要能停掉依赖,不适合放在共享环境里跑。
// 4. 真实 agent 执行(工具调用、沙箱、审批):依赖外部网关,不稳定也慢。
