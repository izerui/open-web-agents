import { describe, expect, it } from "vitest";
import { countAliasUsage } from "../impact";

describe("countAliasUsage:默认路由每个别名有几个智能体在用", () => {
  it("按智能体去重计数,草稿和发布版本里同一个别名只算一次", () => {
    const rows = [
      { agentId: "a", refs: ["sonnet", "sonnet", "haiku"] },
      { agentId: "b", refs: ["sonnet"] },
      { agentId: "c", refs: ["cap-123"] },
      { agentId: "d", refs: [] },
    ];
    expect(countAliasUsage(rows)).toEqual({ fable: 0, opus: 0, sonnet: 2, haiku: 1 });
  });

  it("直接引用具体模型的不算进别名", () => {
    expect(countAliasUsage([{ agentId: "a", refs: ["claude-sonnet-4-5"] }]).sonnet).toBe(0);
  });
});
