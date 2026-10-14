// 审批钩子:本会话有同类授权就放行;否则挂起等人。授权读不到时去问人,而不是自动批准。

import { requestApproval } from "@/lib/modules/approval/application/request-approval";
import {
  type ApprovalOutcome,
  type ApprovalPort,
  type ApprovalRequest,
  ApprovalUnavailable,
  type SessionGrant,
} from "@/lib/modules/approval/ports";
import type { AgentEvent } from "@/lib/shared";
import { describe, expect, it } from "vitest";

function port(opts: { outcome?: ApprovalOutcome; grants?: SessionGrant[] }) {
  const requested: ApprovalRequest[] = [];
  const p: ApprovalPort = {
    request: async (r) => {
      requested.push(r);
      return opts.outcome ?? { decision: "approved" };
    },
    resolve: async () => true,
    listPending: async () => [],
    grants: async () => opts.grants ?? [],
    revokeGrant: async () => true,
  };
  return { p, requested };
}

function deps(approval: ApprovalPort) {
  const events: AgentEvent[] = [];
  return {
    events,
    d: {
      approval,
      publish: async (_s: string, _r: string | undefined, e: AgentEvent) => {
        events.push(e);
      },
      newId: () => "ap1",
      now: () => 1_000,
      timeoutMs: 600_000,
    },
  };
}

const call = {
  sessionId: "s1",
  runId: "r1",
  toolName: "Bash",
  summary: "curl https://x",
  reason: "命令包含高风险模式:curl",
  grant: { key: "bash:curl", label: "含「curl」的命令" },
};

describe("requestApproval", () => {
  it("本会话已授权同类:直接放行,不挂起等人,并在过程里注明", async () => {
    const { p, requested } = port({
      grants: [{ key: "bash:curl", label: "含「curl」的命令", at: 1 }],
    });
    const { d, events } = deps(p);
    expect(await requestApproval(d, call)).toEqual({ approved: true });
    expect(requested).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({ kind: "status", state: "approved_by_grant" }),
    ]);
  });

  it("授权的是别的类别:照常问人,待审里带上类别", async () => {
    const { p, requested } = port({ grants: [{ key: "bash:rm -rf", label: "x", at: 1 }] });
    const { d } = deps(p);
    await requestApproval(d, call);
    expect(requested).toHaveLength(1);
    expect(requested[0]?.grant).toEqual(call.grant);
    expect(requested[0]?.expiresAt).toBe(1_000 + 600_000);
  });

  it("这次调用没有类别:不查授权,照常问人", async () => {
    let looked = false;
    const { p, requested } = port({
      grants: [{ key: "bash:curl", label: "x", at: 1 }],
    });
    p.grants = async () => {
      looked = true;
      return [];
    };
    const { d } = deps(p);
    await requestApproval(d, { ...call, grant: undefined });
    expect(looked).toBe(false);
    expect(requested).toHaveLength(1);
  });

  it("授权读不到:去问人,而不是自动批准", async () => {
    const { p, requested } = port({ outcome: { decision: "denied", message: "不行" } });
    p.grants = async () => {
      throw new ApprovalUnavailable("redis down");
    };
    const { d } = deps(p);
    expect(await requestApproval(d, call)).toEqual({ approved: false, message: "不行" });
    expect(requested).toHaveLength(1);
  });

  it("拒绝说明交给引擎(作为拒绝原因给模型);超时有固定说明", async () => {
    expect(
      await requestApproval(
        deps(port({ outcome: { decision: "denied", message: "改用 wget" } }).p).d,
        call,
      ),
    ).toEqual({ approved: false, message: "改用 wget" });
    expect(
      await requestApproval(deps(port({ outcome: { decision: "expired" } }).p).d, call),
    ).toEqual({
      approved: false,
      message: "审批超时,已自动拒绝",
    });
  });

  it("审批服务不可用:如实标注并继续抛出(引擎按拒绝处理)", async () => {
    const { p } = port({});
    p.request = async () => {
      throw new ApprovalUnavailable("redis down");
    };
    const { d, events } = deps(p);
    await expect(requestApproval(d, call)).rejects.toBeInstanceOf(ApprovalUnavailable);
    expect(events.at(-1)).toMatchObject({ state: "approval_unavailable" });
  });
});
