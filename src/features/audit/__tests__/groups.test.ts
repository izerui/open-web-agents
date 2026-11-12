import { describe, expect, it } from "vitest";
import { ACTION_LABEL, actionGroups } from "../labels";

describe("actionGroups:操作类型筛选的分组", () => {
  const groups = actionGroups();
  const flat = groups.flatMap((g) => g.actions.map((a) => a.value));

  it("覆盖全部操作类型,且每个只出现一次", () => {
    expect(new Set(flat).size).toBe(flat.length);
    expect([...flat].sort()).toEqual(Object.keys(ACTION_LABEL).sort());
  });

  it("按资源归组", () => {
    const of = (action: string) =>
      groups.find((g) => g.actions.some((a) => a.value === action))?.label;
    expect(of("agent.create")).toBe("智能体");
    expect(of("agent.clone")).toBe("智能体");
    expect(of("api_key.rotate")).toBe("API Key");
    expect(of("auth.login_failed")).toBe("登录与账号");
    expect(of("billing.order_create")).toBe("积分与订单");
    expect(of("webhook.redeliver")).toBe("Webhook");
  });

  it("组内项带中文名,组顺序固定以智能体开头", () => {
    expect(groups[0]?.label).toBe("智能体");
    expect(groups[0]?.actions[0]).toEqual({ value: "agent.create", label: "创建智能体" });
    expect(groups.every((g) => g.actions.length > 0)).toBe(true);
  });
});
