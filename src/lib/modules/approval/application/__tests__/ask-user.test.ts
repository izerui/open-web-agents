// 提问在同一轮里等人回答:登记一条带题目的待回答;回答、不回答、超时、停止、通道不可用各有去向,
// 后三种都不卡住运行(当作没有回答)。
import { askUser } from "@/lib/modules/approval/application/ask-user";
import {
  type ApprovalOutcome,
  type ApprovalPort,
  type ApprovalRequest,
  ApprovalUnavailable,
} from "@/lib/modules/approval/ports";
import type { AgentEvent } from "@/lib/shared";
import { describe, expect, it } from "vitest";

const questions = [{ question: "格式?", options: [{ label: "PDF" }, { label: "Word" }] }];

function setup(outcome: ApprovalOutcome | Error) {
  const requested: ApprovalRequest[] = [];
  const events: AgentEvent[] = [];
  const approval: ApprovalPort = {
    request: async (r) => {
      requested.push(r);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    resolve: async () => true,
    listPending: async () => [],
    grants: async () => [],
    revokeGrant: async () => true,
  };
  const deps = {
    approval,
    publish: async (_s: string, _r: string | undefined, e: AgentEvent) => {
      events.push(e);
    },
    newId: () => "q1",
    now: () => 1_000,
    timeoutMs: 600_000,
  };
  return { deps, requested, events };
}
const call = { sessionId: "s1", runId: "r1", toolUseId: "toolu_1", questions };
const states = (events: AgentEvent[]) =>
  events.map((e) => (e.kind === "status" ? e.state : e.kind));

describe("askUser", () => {
  it("登记带题目与 toolUseId 的待回答,上限 10 分钟;回答带回答案", async () => {
    const s = setup({ decision: "approved", by: "u1", answers: { "格式?": "Word" } });
    expect(await askUser(s.deps, call)).toEqual({ answers: { "格式?": "Word" } });
    expect(s.requested).toEqual([
      expect.objectContaining({
        id: "q1",
        sessionId: "s1",
        runId: "r1",
        toolName: "AskUserQuestion",
        toolUseId: "toolu_1",
        questions,
        expiresAt: 601_000,
      }),
    ]);
    expect(states(s.events)).toEqual(["awaiting_answer", "answered"]);
  });

  it("不回答:带回说明", async () => {
    const s = setup({ decision: "denied", message: "不想答" });
    expect(await askUser(s.deps, call)).toEqual({ declined: "不想答" });
    expect(states(s.events)).toEqual(["awaiting_answer", "answer_declined"]);
  });

  it("超时、停止、通道不可用:当作没有回答,不抛错", async () => {
    const expired = setup({ decision: "expired" });
    expect(await askUser(expired.deps, call)).toEqual({});
    expect(states(expired.events).at(-1)).toBe("answer_expired");

    const stopped = setup({ decision: "expired" });
    const ac = new AbortController();
    ac.abort();
    expect(await askUser(stopped.deps, call, ac.signal)).toEqual({});
    expect(stopped.events.at(-1)).toMatchObject({ label: "运行已停止,提问未回答" });

    const down = setup(new ApprovalUnavailable("redis down"));
    expect(await askUser(down.deps, call)).toEqual({});
    expect(states(down.events).at(-1)).toBe("answer_unavailable");
  });

  it("批准却没带答案(不该发生):不编造答案,当作没有回答", async () => {
    const s = setup({ decision: "approved" });
    expect(await askUser(s.deps, call)).toEqual({});
  });
});
