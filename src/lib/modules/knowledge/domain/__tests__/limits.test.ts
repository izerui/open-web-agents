import { KNOWLEDGE_LIMITS, limitViolation } from "@/lib/modules/knowledge/domain/limits";
import { describe, expect, it } from "vitest";

describe("limitViolation", () => {
  const L = { maxDocs: 2, maxDocChars: 10, maxTotalChars: 15 };
  it("单篇、篇数、总字数分别判定;恰好等于上限放行", () => {
    expect(limitViolation({ docs: 0, chars: 0 }, 10, L)).toBeNull();
    expect(limitViolation({ docs: 0, chars: 0 }, 11, L)).toMatch(/单篇/);
    expect(limitViolation({ docs: 2, chars: 0 }, 1, L)).toMatch(/2 篇/);
    expect(limitViolation({ docs: 1, chars: 10 }, 5, L)).toBeNull();
    expect(limitViolation({ docs: 1, chars: 10 }, 6, L)).toMatch(/合计/);
  });
  it("默认上限与接口文案一致", () => {
    expect(KNOWLEDGE_LIMITS).toEqual({
      maxDocs: 500,
      maxDocChars: 200_000,
      maxTotalChars: 5_000_000,
    });
  });
});
