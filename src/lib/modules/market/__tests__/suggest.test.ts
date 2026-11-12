import { describe, expect, it } from "vitest";
import { type SuggestDoc, rankSuggestions, suggestTokens } from "../domain/suggest";

const doc = (over: Partial<SuggestDoc> & { id: string }): SuggestDoc => ({
  name: over.id,
  description: "",
  starters: [],
  category: "",
  mine: false,
  useCount: 0,
  ...over,
});

const MEETING = doc({
  id: "meeting",
  name: "会议纪要整理",
  description: "上传录音或速记，整理出决议和待办",
  starters: ["整理今天的周会录音"],
  category: "办公运营",
});
const WEEKLY = doc({
  id: "weekly",
  name: "周报生成器",
  description: "从日程和聊天记录里汇总本周进展，附上会议纪要链接",
  category: "通用助手",
});
const SQL = doc({
  id: "sql",
  name: "SQL 助手",
  description: "用中文描述要查什么，生成可读的 SQL",
  starters: ["按部门统计上月报销总额"],
  category: "开发工具",
});
const XHS = doc({
  id: "xhs",
  name: "小红书文案",
  description: "按产品卖点写三版笔记",
  category: "内容创作",
});

describe("suggestTokens", () => {
  it("中文按两字切分，去掉停用词；英文按词、不区分大小写", () => {
    const t = suggestTokens("帮我写 SQL 查询");
    expect(t).toContain("sql");
    expect(t).toContain("查询");
    expect(t).not.toContain("帮我");
  });

  it("空串与只有停用词时没有可用的词", () => {
    expect(suggestTokens("")).toEqual([]);
    expect(suggestTokens("   ")).toEqual([]);
    expect(suggestTokens("帮我做一个助手")).toEqual([]);
  });
});

describe("rankSuggestions", () => {
  const docs = [WEEKLY, MEETING, SQL, XHS];

  it("名称命中排在只有说明命中之前", () => {
    const ids = rankSuggestions("整理今天的会议纪要", docs, 3).map((r) => r.id);
    expect(ids[0]).toBe("meeting");
    expect(ids).toContain("weekly");
    expect(ids.indexOf("meeting")).toBeLessThan(ids.indexOf("weekly"));
  });

  it("英文不区分大小写", () => {
    expect(rankSuggestions("sql 查询", docs, 3)[0]?.id).toBe("sql");
  });

  it("示例问题与类别也参与打分", () => {
    expect(rankSuggestions("统计报销总额", docs, 3)[0]?.id).toBe("sql");
    expect(rankSuggestions("内容创作", docs, 3)[0]?.id).toBe("xhs");
  });

  it("只命中单个汉字不算命中", () => {
    expect(rankSuggestions("的", docs, 3)).toEqual([]);
    expect(rankSuggestions("我想要一个东西", docs, 3)).toEqual([]);
  });

  it("没有可用的词时返回空", () => {
    expect(rankSuggestions("", docs, 3)).toEqual([]);
    expect(rankSuggestions("帮我做一个助手", docs, 3)).toEqual([]);
  });

  it("同分时自己的智能体优先，再按使用次数", () => {
    const a = doc({ id: "a", name: "合同比对", useCount: 5 });
    const b = doc({ id: "b", name: "合同比对", useCount: 50 });
    const c = doc({ id: "c", name: "合同比对", mine: true });
    expect(rankSuggestions("合同比对", [a, b, c], 3).map((r) => r.id)).toEqual(["c", "b", "a"]);
  });

  it("最多返回 limit 个，带分数", () => {
    const many = Array.from({ length: 6 }, (_, i) => doc({ id: `m${i}`, name: "会议纪要" }));
    const out = rankSuggestions("会议纪要", many, 3);
    expect(out).toHaveLength(3);
    expect(out[0]?.score).toBeGreaterThan(0);
  });
});
