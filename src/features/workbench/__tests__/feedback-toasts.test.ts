import { sessionLabel } from "@/features/workbench/session-groups";
import type { Turn } from "@/features/workbench/types";
import {
  cornerNoteOffset,
  leftRunningText,
  rerunStartedText,
  toastOffsetAbove,
  unqueuedText,
} from "@/features/workbench/workbench.logic";
import { describe, expect, it } from "vitest";

const turn = (runId?: string): Turn => ({
  localId: runId ?? "x",
  prompt: "p",
  events: [],
  running: false,
  runId,
});

describe("对话页底部提示避开输入框（chat N2）", () => {
  it("提示抬到输入区上沿再往上 12px", () => {
    expect(toastOffsetAbove(900, 760)).toBe("152px");
  });
  it("至少保持全站默认的 28px", () => {
    expect(toastOffsetAbove(900, 899)).toBe("28px");
  });
});

describe("右上角「等你确认」卡片放在对话卡片里、对话头下方（不盖对话头开关，也不盖右侧面板）", () => {
  it("顶部 = 对话卡片上沿 + 对话头高度 + 12；右边 = 对话卡片右沿往里 12", () => {
    // 1440 宽，对话卡片 x∈[285,1031]、上沿 76，对话头 66 高；右侧面板开着
    expect(cornerNoteOffset(1440, { top: 76, right: 1031 }, 66)).toEqual({
      top: "154px",
      right: "421px",
    });
  });
  it("右侧面板关着时对话卡片贴近窗口右边", () => {
    expect(cornerNoteOffset(1440, { top: 76, right: 1424 }, 66)).toEqual({
      top: "154px",
      right: "28px",
    });
  });
});

describe("补上的反馈提示（chat N4）", () => {
  it("取消排队写出取消的是哪条，过长截断", () => {
    expect(unqueuedText("把附件里的发票再核一遍")).toBe("已取消排队：把附件里的发票再核一遍");
    const long = "一".repeat(40);
    expect(unqueuedText(long)).toBe(`已取消排队：${"一".repeat(20)}…`);
  });
  it("没有文字（只带附件）时不写冒号后的内容", () => {
    expect(unqueuedText("  ")).toBe("已取消排队");
  });

  it("重跑写回到了第几轮之前", () => {
    const turns = [turn("r1"), turn("r2"), turn("r3")];
    expect(rerunStartedText(turns, "r1")).toBe("已回到会话开头，正在重跑");
    expect(rerunStartedText(turns, "r3")).toBe("已回到第 3 轮之前的状态，正在重跑");
    expect(rerunStartedText(turns, "nope")).toBe("正在重跑这一轮");
  });

  it("离开运行中的会话", () => {
    expect(leftRunningText("周报汇总")).toBe("「周报汇总」还在后台运行");
  });
});

describe("对话页会话名与 ⌘K 一致（explore-studio N4）", () => {
  const now = new Date(2026, 10, 13, 12, 0).getTime();
  it("有标题用标题", () => {
    expect(sessionLabel({ title: "周报", createdAt: now }, now)).toBe("周报");
  });
  it("没标题用「新对话 · MM-DD HH:mm」，不显示 ID", () => {
    const at = new Date(2026, 10, 12, 9, 5).getTime();
    expect(sessionLabel({ title: "", createdAt: at }, now)).toBe("新对话 · 11-12 09:05");
  });
});
