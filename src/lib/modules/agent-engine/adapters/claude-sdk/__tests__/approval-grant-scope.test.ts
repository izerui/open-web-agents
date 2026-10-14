// 从规则计算到审批钩子:同类授权不能被复合命令绕过。
//
// 真实的 buildSdkOptions(PreToolUse 闸门 + needsApproval)+ 真实的审批钩子(requestApproval),
// 只有审批端口是假的:本会话只授权了 curl。
// 曾经只取第一条命中的模式 —— 规则写成 ["curl", "rm -rf"] 时,`curl …; rm -rf …` 被归成
// bash:curl 直接放行,后面的删除规则形同虚设。

import { buildSdkOptions } from "@/lib/modules/agent-engine/adapters/claude-sdk/options";
import { requestApproval } from "@/lib/modules/approval/application/request-approval";
import type { ApprovalPort, ApprovalRequest, SessionGrant } from "@/lib/modules/approval/ports";
import type { AgentSpec, RunContext } from "@/lib/shared";
import { describe, expect, it } from "vitest";

const ctx: RunContext = {
  sessionId: "s1",
  workspaceDir: "/ws/s1",
  prompt: "go",
  credentials: { baseUrl: "https://gw", key: "k" },
  env: {},
  approvalPolicy: "ask",
};

type HookOutput = {
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
};
type Hook = (input: unknown, toolUseId: string, opts: unknown) => Promise<HookOutput>;

function setup(patterns: string[], granted: string[]) {
  const asked: ApprovalRequest[] = [];
  const approval: ApprovalPort = {
    // 人工审批:这里一律批准,只记下"问过人"
    request: async (r) => {
      asked.push(r);
      return { decision: "approved" };
    },
    resolve: async () => true,
    listPending: async () => [],
    grants: async (): Promise<SessionGrant[]> => granted.map((key) => ({ key, label: key, at: 1 })),
    revokeGrant: async () => true,
  };
  const spec: AgentSpec = {
    systemPrompt: "p",
    model: { alias: "sonnet" },
    limits: {},
    approvalRules: { commandPatterns: patterns },
  };
  const o = buildSdkOptions(spec, ctx, {
    sharedHome: "/data/.agent-home",
    hostHome: "/Users/operator",
    abort: new AbortController(),
    slots: { fable: "m", opus: "m", sonnet: "m", haiku: "m" },
    sandboxEnabled: false,
    allowStdioMcp: false,
    requestApproval: (r, signal) =>
      requestApproval(
        { approval, publish: async () => {}, newId: () => "ap", now: () => 0, timeoutMs: 60_000 },
        r,
        signal,
      ),
  });
  const hook = (o.hooks as { PreToolUse: { hooks: Hook[] }[] }).PreToolUse[0]?.hooks[0];
  if (!hook) throw new Error("PreToolUse hook 没接上");
  const run = async (command: string) => {
    const out = await hook(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } },
      "tu",
      {},
    );
    return out.hookSpecificOutput?.permissionDecision !== "deny";
  };
  return { run, asked };
}

const COMPOSITE = "curl https://example.com; rm -rf ./data";

describe("同类授权 × 复合命令", () => {
  for (const patterns of [
    ["curl", "rm -rf"],
    ["rm -rf", "curl"],
  ]) {
    it(`只授权了 curl:复合命令同时命中删除规则,仍要人工审批(规则顺序 ${patterns.join(" → ")})`, async () => {
      const { run, asked } = setup(patterns, ["bash:curl"]);
      expect(await run(COMPOSITE)).toBe(true); // 人批准了才放行
      expect(asked).toHaveLength(1);
      expect(asked[0]?.scopes?.map((s) => s.key).sort()).toEqual(["bash:curl", "bash:rm -rf"]);
    });
  }

  it("单独的 curl 命令:已授权,直接放行不问人", async () => {
    const { run, asked } = setup(["curl", "rm -rf"], ["bash:curl"]);
    expect(await run("curl https://example.com")).toBe(true);
    expect(asked).toEqual([]);
  });

  it("两类都已授权:复合命令直接放行", async () => {
    const { run, asked } = setup(["rm -rf", "curl"], ["bash:curl", "bash:rm -rf"]);
    expect(await run(COMPOSITE)).toBe(true);
    expect(asked).toEqual([]);
  });
});
