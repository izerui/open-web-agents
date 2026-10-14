// 历史回放的编排逻辑:runs 表定骨架(轮次顺序与提示词),transcript 填血肉(过程事件)。
//
// 这里用假的 repo 与 transcript —— 编排本身没有 IO,真正读盘的正确性由
// jsonl-transcript.test.ts 用真实文件覆盖。两层各测各的,不重叠。

import type { TranscriptPort } from "@/lib/modules/agent-engine/ports";
import { loadSessionHistory } from "@/lib/modules/run/application/history";
import type { AgentEvent } from "@/lib/shared";
import { describe, expect, it } from "vitest";

type RunRow = {
  id: string;
  status: string;
  prompt: string;
  parentRunId?: string;
  sdkSessionId?: string;
  transcriptRange?: { first: string; last: string };
  createdAt: number;
};

function deps(args: {
  runs?: RunRow[];
  session?: { workspaceDir: string } | null;
  byTranscript?: Record<string, AgentEvent[]>;
  onRead?: (sdkSessionId: string, range?: { first: string; last: string }) => void;
}) {
  const table = args.byTranscript ?? {};
  const transcript: TranscriptPort = {
    async read({ sdkSessionId, range }) {
      args.onRead?.(sdkSessionId, range);
      return table[sdkSessionId] ?? [];
    },
  };
  return {
    dataDir: "/data",
    sessions: {
      async get() {
        return args.session === undefined ? { workspaceDir: "/data/workspaces/s1" } : args.session;
      },
    },
    runs: {
      async listBySession() {
        return args.runs ?? [];
      },
    },
    transcript,
  };
}

const textEvent = (t: string): AgentEvent => ({ kind: "text", text: t });

describe("loadSessionHistory", () => {
  it("终态运行的过程从 transcript 还原", async () => {
    const h = await loadSessionHistory(
      deps({
        runs: [
          { id: "r1", status: "success", prompt: "列个目录", sdkSessionId: "sdk1", createdAt: 1 },
        ],
        byTranscript: { sdk1: [textEvent("好的")] },
      }),
      "s1",
    );
    expect(h?.turns).toHaveLength(1);
    expect(h?.turns[0]).toMatchObject({ prompt: "列个目录", runId: "r1", running: false });
    expect(h?.turns[0]?.events).toEqual([textEvent("好的")]);
  });

  it("按 createdAt 排序,不依赖 repo 的返回顺序", async () => {
    const h = await loadSessionHistory(
      deps({
        runs: [
          { id: "r2", status: "success", prompt: "第二轮", sdkSessionId: "sdk2", createdAt: 20 },
          { id: "r1", status: "success", prompt: "第一轮", sdkSessionId: "sdk1", createdAt: 10 },
        ],
      }),
      "s1",
    );
    expect(h?.turns.map((t) => t.prompt)).toEqual(["第一轮", "第二轮"]);
  });

  it("活跃运行【不读 transcript】—— 它那段由实时流负责", async () => {
    // 这是"历史回放"与"实时流"不重复的结构性保证:两个来源各管一段。
    // 一旦这里也去读 jsonl,同一批事件就会同时从两条路进来,前端得按 uuid 去重 ——
    // 而 AgentEvent 里根本没有 uuid,去不了。
    const reads: string[] = [];
    const h = await loadSessionHistory(
      deps({
        runs: [
          { id: "r1", status: "success", prompt: "已完成", sdkSessionId: "sdk1", createdAt: 1 },
          { id: "r2", status: "running", prompt: "进行中", sdkSessionId: "sdk2", createdAt: 2 },
        ],
        byTranscript: { sdk1: [textEvent("done")], sdk2: [textEvent("不该被读到")] },
        onRead: (s) => reads.push(s),
      }),
      "s1",
    );
    expect(reads).toEqual(["sdk1"]);
    expect(h?.turns[1]).toMatchObject({ prompt: "进行中", running: true });
    expect(h?.turns[1]?.events).toEqual([]);
  });

  it("报出活跃运行的 id,供前端接回实时流", async () => {
    const h = await loadSessionHistory(
      deps({
        runs: [{ id: "r2", status: "pending", prompt: "排队中", createdAt: 2 }],
      }),
      "s1",
    );
    expect(h?.activeRunId).toBe("r2");
  });

  it("全部跑完时没有活跃运行", async () => {
    const h = await loadSessionHistory(
      deps({ runs: [{ id: "r1", status: "success", prompt: "done", createdAt: 1 }] }),
      "s1",
    );
    expect(h?.activeRunId).toBeUndefined();
  });

  it("运行没有 sdkSessionId 时仍给出失败终态,不去读盘", async () => {
    // 引擎还没起来就失败的运行没有 transcript。历史仍要说清楚失败了，
    // 不能只显示提示词，让用户误以为回答丢了。
    const reads: string[] = [];
    const h = await loadSessionHistory(
      deps({
        runs: [{ id: "r1", status: "failed", prompt: "起不来", createdAt: 1 }],
        onRead: (s) => reads.push(s),
      }),
      "s1",
    );
    expect(reads).toEqual([]);
    expect(h?.turns[0]).toMatchObject({ prompt: "起不来", running: false });
    expect(h?.turns[0]?.events).toEqual([
      {
        kind: "result",
        status: "failed",
        summary: "运行失败，未生成可回放的过程",
        runId: "r1",
      },
    ]);
  });

  it("取消的运行在历史里保留明确终态", async () => {
    const h = await loadSessionHistory(
      deps({
        runs: [{ id: "r1", status: "cancelled", prompt: "停下来", createdAt: 1 }],
      }),
      "s1",
    );
    expect(h?.turns[0]?.events).toEqual([
      { kind: "result", status: "cancelled", summary: "运行已取消", runId: "r1" },
    ]);
  });

  it("数据库已取消时覆盖 transcript 里稍后写入的失败结局", async () => {
    const h = await loadSessionHistory(
      deps({
        runs: [
          { id: "r1", status: "cancelled", prompt: "停下来", sdkSessionId: "sdk1", createdAt: 1 },
        ],
        byTranscript: {
          sdk1: [
            textEvent("已开始"),
            { kind: "result", status: "failed", summary: "aborted", runId: "r1" },
          ],
        },
      }),
      "s1",
    );
    expect(h?.turns[0]?.events).toEqual([
      textEvent("已开始"),
      { kind: "result", status: "cancelled", summary: "运行已取消", runId: "r1" },
    ]);
  });

  it("带上分支来源,界面才画得出分叉标记", async () => {
    const h = await loadSessionHistory(
      deps({
        runs: [{ id: "r2", status: "success", prompt: "重跑", parentRunId: "r1", createdAt: 2 }],
      }),
      "s1",
    );
    expect(h?.turns[0]?.branchedFrom).toBe("r1");
  });

  it("会话不存在时返回 null,由路由翻成 404", async () => {
    const h = await loadSessionHistory(deps({ session: null }), "nope");
    expect(h).toBeNull();
  });

  it("单轮 transcript 读失败不牵连其它轮次", async () => {
    // 一个文件损坏/无权读,不该让整份历史 500 —— 其余轮次本来是好的。
    const transcript: TranscriptPort = {
      async read({ sdkSessionId }) {
        if (sdkSessionId === "bad") throw new Error("EACCES");
        return [textEvent("好的")];
      },
    };
    const h = await loadSessionHistory(
      {
        ...deps({
          runs: [
            { id: "r1", status: "success", prompt: "坏的", sdkSessionId: "bad", createdAt: 1 },
            { id: "r2", status: "success", prompt: "好的", sdkSessionId: "ok", createdAt: 2 },
          ],
        }),
        transcript,
      },
      "s1",
    );
    expect(h?.turns[0]?.events).toEqual([]);
    expect(h?.turns[1]?.events).toEqual([textEvent("好的")]);
  });

  it("续接同一 SDK 会话的各轮共用一份 transcript:每轮按自己的范围读", async () => {
    const reads: unknown[] = [];
    await loadSessionHistory(
      deps({
        runs: [
          {
            id: "r1",
            status: "success",
            prompt: "一",
            sdkSessionId: "same",
            transcriptRange: { first: "a1", last: "a1" },
            createdAt: 1,
          },
          {
            id: "r2",
            status: "success",
            prompt: "二",
            sdkSessionId: "same",
            transcriptRange: { first: "a2", last: "a3" },
            createdAt: 2,
          },
        ],
        onRead: (sid, range) => reads.push({ sid, range }),
      }),
      "s1",
    );
    expect(reads).toEqual([
      { sid: "same", range: { first: "a1", last: "a1" } },
      { sid: "same", range: { first: "a2", last: "a3" } },
    ]);
  });
});
