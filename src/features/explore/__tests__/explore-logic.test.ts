import { describe, expect, it } from "vitest";
import {
  type MarketListItem,
  chatHref,
  designerHref,
  filterMarket,
  sortMarket,
  workStatusLabel,
} from "../explore-logic";

const item = (over: Partial<MarketListItem> & { id: string }): MarketListItem => ({
  name: over.id,
  description: "",
  category: "general",
  useCount: 0,
  publishedAt: null,
  ...over,
});

describe("designerHref", () => {
  it("把描述带给新建页", () => {
    expect(designerHref("做一个审核报销单的助手，超过 5000 元提醒我")).toBe(
      `/agents/new?desc=${encodeURIComponent("做一个审核报销单的助手，超过 5000 元提醒我")}`,
    );
    expect(designerHref("a&b=c")).toBe("/agents/new?desc=a%26b%3Dc");
  });
  it("没有描述时不带参数", () => {
    expect(designerHref("  ")).toBe("/agents/new");
  });
});

describe("chatHref", () => {
  it("对话页暂不接 q 参数:只带会话", () => {
    expect(chatHref("s 1", "整理今天的周会录音")).toBe("/chat?session=s%201");
    expect(chatHref("s1")).toBe("/chat?session=s1");
  });
});

describe("filterMarket / sortMarket", () => {
  const list = [
    item({ id: "a", name: "会议纪要整理", category: "operations", useCount: 10, publishedAt: 3 }),
    item({
      id: "b",
      name: "SQL 助手",
      description: "生成 SQL",
      category: "development",
      useCount: 90,
      publishedAt: 1,
    }),
    item({
      id: "c",
      name: "周报",
      description: "汇总会议",
      category: "general",
      useCount: 50,
      publishedAt: 2,
    }),
  ];

  it("按类别与名称说明筛选,不区分大小写", () => {
    expect(filterMarket(list, { category: "", search: "" }).map((i) => i.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(filterMarket(list, { category: "development", search: "" }).map((i) => i.id)).toEqual([
      "b",
    ]);
    expect(filterMarket(list, { category: "", search: "sql" }).map((i) => i.id)).toEqual(["b"]);
    expect(filterMarket(list, { category: "", search: " 会议 " }).map((i) => i.id)).toEqual([
      "a",
      "c",
    ]);
  });

  it("最常用按使用次数,最新按发布时间,不改原数组", () => {
    expect(sortMarket(list, "hot").map((i) => i.id)).toEqual(["b", "c", "a"]);
    expect(sortMarket(list, "new").map((i) => i.id)).toEqual(["a", "c", "b"]);
    expect(list.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
});

describe("workStatusLabel", () => {
  it("每种状态都有中文标签与色调", () => {
    expect(workStatusLabel("running")).toEqual({ label: "正在工作", tone: "warning" });
    expect(workStatusLabel("delivered")).toEqual({ label: "成果已交付", tone: "success" });
    expect(workStatusLabel("replied")).toEqual({ label: "已回复", tone: "success" });
    expect(workStatusLabel("failed")).toEqual({ label: "失败", tone: "destructive" });
    expect(workStatusLabel("cancelled")).toEqual({ label: "已停止", tone: "muted" });
    expect(workStatusLabel("idle")).toEqual({ label: "还没开始", tone: "muted" });
  });
});
