import { ACTION_LABEL, describeAudit } from "@/features/audit/labels";
import { AUDIT_ACTIONS } from "@/lib/modules/audit/domain/events";
import { describe, expect, it } from "vitest";

const item = (action: string, details: Record<string, unknown>) => ({
  id: "1",
  at: 0,
  actor: { type: "user" as const, id: "u1" },
  action,
  resource: { type: "agent" },
  details,
});

describe("审计展示", () => {
  it("每个动作都有中文名", () => {
    for (const a of AUDIT_ACTIONS) expect(ACTION_LABEL[a]).toBeTruthy();
  });

  it("一句话描述", () => {
    expect(describeAudit(item("agent.publish", { version: 3, note: "加配音" }))).toBe(
      "发布 v3:加配音",
    );
    expect(describeAudit(item("agent.activate_version", { from: 3, to: 1 }))).toBe(
      "发布版本 v3 → v1",
    );
    expect(
      describeAudit(
        item("agent.update", { name: "视频", changed: ["systemPrompt", "skillPackages"] }),
      ),
    ).toBe("「视频」:改动 systemPrompt、skillPackages");
    expect(
      describeAudit(
        item("approval.decide", { decision: "denied", tool: "Bash", summary: "rm -rf /" }),
      ),
    ).toBe("拒绝 Bash:rm -rf /");
    expect(describeAudit(item("api_key.rate_limit", { name: "订单", from: null, to: 10 }))).toBe(
      "「订单」每分钟上限 默认 → 10",
    );
  });
});
