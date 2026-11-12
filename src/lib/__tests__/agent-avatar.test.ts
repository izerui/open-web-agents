import { describe, expect, it } from "vitest";
import { AVATAR_COLORS, avatarStyle, formatAvatarIcon } from "../agent-avatar";

describe("avatarStyle", () => {
  it("同一个 id 每次得到同一个头像", () => {
    expect(avatarStyle("expense-reviewer")).toEqual(avatarStyle("expense-reviewer"));
  });

  it("不同 id 会分散到多种颜色", () => {
    const ids = Array.from({ length: 20 }, (_, i) => `agent-${i}`);
    const colors = new Set(ids.map((id) => avatarStyle(id).color));
    expect(colors.size).toBeGreaterThanOrEqual(3);
    for (const c of colors) expect(AVATAR_COLORS).toContain(c);
  });

  it("配置里写了合法的 icon 就按 icon", () => {
    expect(avatarStyle("x", "avatar:#C8C2E8:round")).toEqual({ color: "#C8C2E8", eyes: "round" });
  });

  it("icon 不合法时回落到按 id 计算", () => {
    expect(avatarStyle("x", "🙂")).toEqual(avatarStyle("x"));
    expect(avatarStyle("x", "avatar:red:pill")).toEqual(avatarStyle("x"));
    expect(avatarStyle("x", "avatar:#C8C2E8:wink")).toEqual(avatarStyle("x"));
    expect(avatarStyle("x", null)).toEqual(avatarStyle("x"));
  });

  it("智能体设计器(agent-architect)固定是黑底白眼", () => {
    expect(avatarStyle("agent-architect")).toEqual({ color: "#1F1E1C", eyes: "white" });
  });

  it("icon 里写白眼也不行:白眼只属于智能体设计器", () => {
    expect(avatarStyle("x", "avatar:#C8C2E8:white")).toEqual(avatarStyle("x"));
  });

  it("其他智能体不会被分到设计器专用的白眼", () => {
    const ids = Array.from({ length: 50 }, (_, i) => `a${i}`);
    expect(ids.every((id) => avatarStyle(id).eyes !== "white")).toBe(true);
  });

  it("formatAvatarIcon 与 avatarStyle 往返一致", () => {
    const style = { color: "#F2B49B", eyes: "pill" } as const;
    expect(formatAvatarIcon(style)).toBe("avatar:#F2B49B:pill");
    expect(avatarStyle("whatever", formatAvatarIcon(style))).toEqual(style);
  });
});
