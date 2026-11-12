import { describe, expect, it } from "vitest";
import {
  canCancelRun,
  formatDuration,
  hasChatTranscript,
  looksLikeJson,
  prettyInput,
  runCreditsText,
  tokensText,
  versionLabel,
} from "../run-format";

describe("formatDuration", () => {
  it.each([
    [undefined, "—"],
    [850, "850 毫秒"],
    [38_000, "38 秒"],
    [59_600, "1 分 0 秒"],
    [72_000, "1 分 12 秒"],
  ])("%s → %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe("canCancelRun:只有排队中和运行中能取消", () => {
  it.each([
    ["pending", true],
    ["running", true],
    ["success", false],
    ["failed", false],
    ["cancelled", false],
  ] as const)("%s → %s", (status, ok) => {
    expect(canCancelRun(status)).toBe(ok);
  });
});

describe("versionLabel", () => {
  it("没有版本是草稿", () => {
    expect(versionLabel(undefined)).toBe("草稿");
    expect(versionLabel(3)).toBe("v3");
  });
});

describe("tokensText", () => {
  it("合计输入输出,千位以 k 表示", () => {
    expect(tokensText({ input: 12_000, output: 100 })).toBe("12.1k tokens");
    expect(tokensText({ input: 300, output: 20 })).toBe("320 tokens");
    expect(tokensText({ input: 1_200_000, output: 0 })).toBe("1.2M tokens");
  });
  it("没有用量返回 null", () => {
    expect(tokensText(undefined)).toBeNull();
    expect(tokensText({ input: 0, output: 0 })).toBeNull();
  });
});

describe("输入的展示", () => {
  it("JSON 对象美化,文本原样", () => {
    expect(looksLikeJson('{ "a": 1 }')).toBe(true);
    expect(looksLikeJson("你好")).toBe(false);
    expect(prettyInput('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyInput("{坏的")).toBe("{坏的");
    expect(prettyInput("普通文本")).toBe("普通文本");
  });
});

describe("runCreditsText:运行花费一律显示积分", () => {
  it("已结算显示实际扣除", () => {
    expect(runCreditsText({ micro: "1500000", state: "settled" })).toBe("1.50 积分");
  });
  it("冻结中写明是冻结", () => {
    expect(runCreditsText({ micro: "9000000", state: "open" })).toBe("冻结 9.00 积分");
  });
  it("没有扣费记录返回 null(不退回显示美元)", () => {
    expect(runCreditsText(undefined)).toBeNull();
  });
});

describe("hasChatTranscript:哪些运行能在对话里查看", () => {
  it.each(["web", "api", "try", "trial", "design"])("%s 有对话", (s) => {
    expect(hasChatTranscript(s)).toBe(true);
  });
  it.each(["invoke", "eval"])("%s 没有可查看的对话", (s) => {
    expect(hasChatTranscript(s)).toBe(false);
  });
});
