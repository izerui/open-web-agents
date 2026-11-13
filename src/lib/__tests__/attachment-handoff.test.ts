import { describe, expect, it } from "vitest";
import { handOffAttachments, takeAttachments } from "../attachment-handoff";

const file = (name: string) => new File(["x"], name, { type: "text/plain" });

describe("探索首页 → 对话页的附件交接", () => {
  it("交给哪个会话,只有那个会话取得到,取走即删", () => {
    handOffAttachments("s1", [file("报销单.pdf")], 1000);
    expect(takeAttachments("s2", 1000)).toEqual([]);
    expect(takeAttachments("s1", 1000).map((f) => f.name)).toEqual(["报销单.pdf"]);
    expect(takeAttachments("s1", 1000)).toEqual([]);
  });

  it("过期(2 分钟)后不再给", () => {
    handOffAttachments("s1", [file("a.txt")], 0);
    expect(takeAttachments("s1", 2 * 60 * 1000 + 1)).toEqual([]);
  });

  it("没有会话 id 时不给;新的交接覆盖旧的", () => {
    handOffAttachments("s1", [file("a.txt")], 0);
    expect(takeAttachments(null, 0)).toEqual([]);
    handOffAttachments("s2", [file("b.txt")], 0);
    expect(takeAttachments("s1", 0)).toEqual([]);
    expect(takeAttachments("s2", 0).map((f) => f.name)).toEqual(["b.txt"]);
  });

  it("空列表等于清空", () => {
    handOffAttachments("s1", [file("a.txt")], 0);
    handOffAttachments("s1", [], 0);
    expect(takeAttachments("s1", 0)).toEqual([]);
  });
});
