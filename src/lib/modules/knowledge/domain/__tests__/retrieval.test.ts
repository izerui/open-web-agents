import {
  type Chunk,
  chunkText,
  formatContext,
  retrieve,
  scoreChunks,
  tokenize,
} from "@/lib/modules/knowledge/domain/retrieval";
import { describe, expect, it } from "vitest";

const chunk = (docId: string, index: number, text: string, docTitle = docId): Chunk => ({
  docId,
  docTitle,
  index,
  text,
});

describe("chunkText", () => {
  it("短文本不切", () => {
    expect(chunkText("短文本")).toEqual(["短文本"]);
  });

  it("空白返回空数组", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n  ")).toEqual([]);
  });

  it("长文本按大小切开", () => {
    const parts = chunkText("x".repeat(1000), 300, 50);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(300);
  });

  it("片段之间有重叠 —— 否则跨切点的句子两边都检索不到", () => {
    const text = `${"a".repeat(300)}关键短语${"b".repeat(300)}`;
    const parts = chunkText(text, 320, 100);
    // 关键短语跨在切点附近,应至少完整出现在某一片段里
    expect(parts.some((p) => p.includes("关键短语"))).toBe(true);
  });

  it("覆盖到文本末尾,不丢尾巴", () => {
    const parts = chunkText(`${"a".repeat(500)}结尾标记`, 200, 50);
    expect(parts.some((p) => p.includes("结尾标记"))).toBe(true);
  });
});

describe("tokenize", () => {
  it("英文按词切并小写化", () => {
    expect(tokenize("Hello World")).toContain("hello");
    expect(tokenize("Hello World")).toContain("world");
  });

  it("忽略单字母噪声", () => {
    expect(tokenize("a b cd")).toEqual(["cd"]);
  });

  it("中文出单字与二元组 —— 没有分词器时这样召回最稳", () => {
    const t = tokenize("发票");
    expect(t).toContain("发");
    expect(t).toContain("票");
    expect(t).toContain("发票");
  });

  it("中英混排都能切", () => {
    const t = tokenize("申请 invoice 报销");
    expect(t).toContain("invoice");
    expect(t).toContain("报销");
  });

  it("空文本返回空", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("!!! ???")).toEqual([]);
  });
});

describe("scoreChunks", () => {
  const chunks = [
    chunk("d1", 0, "报销流程:先在系统提交发票,再由主管审批。"),
    chunk("d1", 1, "年假制度:每年 10 天,需提前三天申请。"),
    chunk("d2", 0, "出差标准:市内交通实报实销。"),
  ];

  it("命中的片段得分为正", () => {
    const s = scoreChunks("发票怎么报销", chunks);
    const hit = s.find((x) => x.text.includes("报销流程"));
    expect(hit?.score).toBeGreaterThan(0);
  });

  it("最相关的片段分最高", () => {
    const best = scoreChunks("发票报销", chunks).sort((a, b) => b.score - a.score)[0];
    expect(best?.text).toContain("报销流程");
  });

  it("完全不相关的查询全为 0 分", () => {
    const s = scoreChunks("量子计算 xyz", chunks);
    expect(s.every((x) => x.score === 0)).toBe(true);
  });

  it("空查询或空片段集安全返回", () => {
    expect(scoreChunks("", chunks)).toEqual([]);
    expect(scoreChunks("发票", [])).toEqual([]);
  });

  it("长片段不因为字多就占便宜(长度归一)", () => {
    const short = chunk("s", 0, "发票报销");
    const padded = chunk("l", 0, `发票报销${"无关内容".repeat(80)}`);
    const s = scoreChunks("发票报销", [short, padded]);
    const sv = s.find((x) => x.docId === "s")?.score ?? 0;
    const lv = s.find((x) => x.docId === "l")?.score ?? 0;
    expect(sv).toBeGreaterThan(lv);
  });

  it("到处都出现的词被降权(IDF)", () => {
    const common = [
      chunk("a", 0, "公司规定 报销"),
      chunk("b", 0, "公司规定 年假"),
      chunk("c", 0, "公司规定 出差"),
    ];
    // "报销"只在一处出现,应比到处都有的"公司"更能区分
    const s = scoreChunks("公司 报销", common);
    const best = s.sort((x, y) => y.score - x.score)[0];
    expect(best?.docId).toBe("a");
  });
});

describe("retrieve", () => {
  const chunks = [
    chunk("d1", 0, "报销流程:先在系统提交发票,再由主管审批。", "员工手册"),
    chunk("d1", 1, "年假制度:每年 10 天。", "员工手册"),
    chunk("d2", 0, "出差标准:市内交通实报实销。", "差旅规定"),
  ];

  it("返回最相关的片段", () => {
    const hits = retrieve("发票报销", chunks);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.text).toContain("报销流程");
  });

  it("受 topK 限制", () => {
    expect(retrieve("报销 年假 出差", chunks, { topK: 1 })).toHaveLength(1);
  });

  it("命中不了就返回空 —— 塞不相关内容比不塞更糟", () => {
    expect(retrieve("量子纠缠 xyz", chunks)).toEqual([]);
  });

  it("低于阈值的片段被滤掉", () => {
    expect(retrieve("报销", chunks, { minScore: 999 })).toEqual([]);
  });

  it("总字数受限,不挤爆提示词预算", () => {
    const big = [chunk("x", 0, `报销${"内容".repeat(2000)}`)];
    expect(retrieve("报销", big, { maxChars: 100 })).toEqual([]);
  });

  it("按分数降序", () => {
    const scores = retrieve("报销 年假", chunks, { topK: 5 }).map((h) => h.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });
});

describe("formatContext", () => {
  it("空结果返回空串,调用方据此决定不注入", () => {
    expect(formatContext([])).toBe("");
  });

  it("带上文档标题与片段序号,便于溯源", () => {
    const out = formatContext([{ ...chunk("d1", 0, "正文", "员工手册"), score: 1 }]);
    expect(out).toContain("员工手册");
    expect(out).toContain("片段 1");
    expect(out).toContain("正文");
  });

  it("明确要求资料没提到的不要编造", () => {
    const out = formatContext([{ ...chunk("d1", 0, "正文"), score: 1 }]);
    expect(out).toMatch(/不要编造|如实说明/);
  });
});

// 相关性下限曾是固定的 0.1 绝对阈值。BM25 的 IDF 随词频上升而衰减,而智能体知识库
// 按定义就是主题集中的语料 —— 同一批文档,分数随语料规模整体下移,于是
// 【知识库越完善越检索不到】,且返回空之后没有任何"未命中"信号,
// 模型转而凭参数记忆作答,表面上一切正常。
// 原有用例全是几条文档的小语料,压根碰不到这个拐点。
describe("retrieve / 【规模回归】判定不随语料规模漂移", () => {
  /** 1 篇目标 + n 篇同主题干扰件 —— 智能体知识库的典型形态。 */
  const corpus = (n: number): Chunk[] => [
    chunk("target", 0, "开具增值税专用发票的流程:登录开票系统,录入购方信息,选择税率后确认开具。"),
    ...Array.from({ length: n }, (_, i) =>
      chunk(`f${i}`, 0, `差旅报销细则第 ${i} 条:住宿、交通、餐饮的限额与审批流程说明。`),
    ),
  ];

  for (const n of [4, 19, 49, 119]) {
    it(`语料 ${n + 1} 篇时仍命中目标(绝对阈值 0.1 在 50 篇上会归零)`, () => {
      const hits = retrieve("开发票的流程", corpus(n));
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.docId).toBe("target");
    });
  }

  it("命中集合在各规模下保持一致 —— 加文档不该让已命中的内容消失", () => {
    const ids = (n: number) =>
      retrieve("开发票的流程", corpus(n))
        .map((h) => h.docId)
        .sort();
    expect(ids(49)).toEqual(ids(4));
  });

  // 相对阈值自带一个风险:退化成「总有结果」—— 一堆毫不相干的片段里"最不差的"也过线。
  // 光调阈值治不了,噪声得在源头去掉:单字分词让「的」这类虚词把任意两段中文都连上,
  // 实测问「量子纠缠」能让一篇讲差旅报销的文档拿到 0.09 分,全靠一个「的」字。
  it("不相关的查询必须返回空 —— 相对阈值不能变成「总有结果」", () => {
    expect(retrieve("量子纠缠的实验验证", corpus(4))).toEqual([]);
    expect(retrieve("量子纠缠的实验验证", corpus(49))).toEqual([]);
  });

  it("纯虚词查询不该命中任何东西", () => {
    expect(retrieve("的了是在", corpus(49))).toEqual([]);
    expect(retrieve("这个是那个的", corpus(49))).toEqual([]);
  });

  it("显式传 minScore 时仍按绝对阈值(调用方明确要求就照办)", () => {
    const top = retrieve("开发票的流程", corpus(49))[0]?.score ?? 0;
    expect(top).toBeGreaterThan(0);
    expect(retrieve("开发票的流程", corpus(49), { minScore: top + 1 })).toEqual([]);
    expect(retrieve("开发票的流程", corpus(49), { minScore: top })).toHaveLength(1);
  });
});
