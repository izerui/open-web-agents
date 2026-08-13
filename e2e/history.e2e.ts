// 历史会话回放的端到端回归。
//
// 【为什么必须有这一条】history 的编排逻辑有单测,jsonl 读盘也有单测 ——
// 但那两层之间的【接线】没有任何测试覆盖:路由路径写错、container 忘了装配
// transcript、env.dataDir 传错,单测全绿而功能整个是坏的。
// 这一条打的就是接线:从 HTTP 进,穿过路由 → 容器 → 用例 → adapter。
//
// 不覆盖"真跑一轮 agent 再回放"——那要真实模型网关,属于慢路径;
// 文件末尾如实列出没覆盖什么。

import { beforeAll, describe, expect, it } from "vitest";
import { type Client, newUser, serverUp } from "./client";

type SessionRes = { session?: { id: string } };
type ListRes = { agents?: { id: string }[] };
type HistoryRes = {
  turns?: { prompt: string; events: unknown[]; running: boolean; runId: string }[];
  activeRunId?: string;
};

describe("历史会话回放", () => {
  let a: Client;
  let b: Client;
  let sessionId: string;

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
    a = await newUser("hist-a");
    b = await newUser("hist-b");
    const list = await a.get<ListRes>("/api/agents");
    const agentId = list.body.agents?.[0]?.id;
    expect(agentId).toBeTruthy();
    const s = await a.post<SessionRes>("/api/sessions", { agentId });
    sessionId = s.body.session?.id ?? "";
    expect(sessionId).toBeTruthy();
  });

  it("新建会话的历史是空的,而不是报错", async () => {
    // 一轮都没跑过 → turns 为空数组。若这里 500,说明 transcript 没装配上,
    // 或者 dataDir 传错导致读盘抛了异常。
    const r = await a.get<HistoryRes>(`/api/sessions/${sessionId}/history`);
    expect(r.status).toBe(200);
    expect(r.body.turns).toEqual([]);
    expect(r.body.activeRunId).toBeUndefined();
  });

  it("别人读不到我的历史", async () => {
    // 过程里有工具调用参数与产出,和工作空间文件一样敏感 —— 必须过归属校验。
    const r = await b.get(`/api/sessions/${sessionId}/history`);
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it("未登录读不到历史", async () => {
    const r = await fetch(
      `${process.env.OWA_E2E_BASE_URL ?? "http://localhost:5678"}/api/sessions/${sessionId}/history`,
    );
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it("不存在的会话回 4xx 而不是 500", async () => {
    const r = await a.get("/api/sessions/nonexistent-session-id/history");
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });

  it("会话 id 里的路径穿越不会变成任意文件读", async () => {
    // sdkSessionId 与 sessionId 都参与磁盘路径拼接,这是最要命的一类输入。
    for (const evil of ["..%2F..%2Fetc%2Fpasswd", "..", "%2e%2e%2f%2e%2e"]) {
      const r = await a.get(`/api/sessions/${evil}/history`);
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
    }
  });
});

// ── 本文件【没有】覆盖的 ────────────────────────────────────────────
// 1. 真跑一轮 agent 后回放出完整过程 —— 需要可用的模型网关,属慢路径。
//    读盘还原的正确性由 jsonl-transcript.test.ts 用真实 jsonl 形状覆盖。
// 2. 活跃轮自动接回实时流 —— 需要一轮跑到一半的运行,时序不稳定。
//    「活跃轮不读 transcript」这条不变量由 history.test.ts 覆盖。
// 3. 前端渲染 —— 项目没有组件测试基建(vitest 跑 node 环境、只收 .ts)。
