import { describe, expect, it } from "vitest";
import { categoryLabel, reviewCategory } from "../listing-review";

describe("上架审核的默认类别", () => {
  it("先用申请里的类别,为空再用智能体当前类别,都没有用通用助手;无效值跳过", () => {
    expect(reviewCategory({ requestedCategory: "content", agentCategory: "research" })).toBe(
      "content",
    );
    expect(reviewCategory({ requestedCategory: null, agentCategory: "research" })).toBe("research");
    expect(reviewCategory({ requestedCategory: "gone", agentCategory: null })).toBe("general");
    expect(reviewCategory({})).toBe("general");
  });

  it("申请卡上的类别标签:申请类别优先,旧申请没有类别时写明是当前类别", () => {
    expect(categoryLabel({ requestedCategory: "content", agentCategory: "research" })).toBe(
      "申请类别：内容创作",
    );
    expect(categoryLabel({ agentCategory: "research" })).toBe("当前类别：研究分析");
    expect(categoryLabel({})).toBe("申请类别：未选");
  });
});
