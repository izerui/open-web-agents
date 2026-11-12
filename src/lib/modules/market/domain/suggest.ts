/**
 * 探索首页「想交给它什么事」的推荐打分(gaps.md A1 第一版:关键词匹配,不调模型)。
 *
 * 切词规则刻意简单:中文按相邻两字切(「会议纪要」→ 会议 / 议纪 / 纪要),
 * 英文和数字按整词、不区分大小写。单个汉字不算词 —— 「的」「我」这种字处处都有,
 * 拿它们打分只会把不相干的智能体推上来。
 *
 * 分数 = 每个词在哪个字段命中就取那个字段的权重(取最高的一个),再累加:
 * 名称 5、示例问题 3、说明 2、类别 2。名称命中比说明命中更像「就是它」。
 */

export interface SuggestDoc {
  id: string;
  name: string;
  description: string;
  starters: readonly string[];
  /** 类别的中文名 */
  category: string;
  /** 当前用户自己的智能体(同分时优先) */
  mine: boolean;
  /** 近 90 天使用次数(同分时多的优先) */
  useCount: number;
}

export interface Suggestion {
  id: string;
  score: number;
}

/** 含这些字的两字组合不算词:虚词、代词、量词,命中了也说明不了什么 */
const STOP_CHARS = new Set("的了我你他她它是在和与及把给个这那么吗呢吧啊一也就都请让被");

/** 口头禅与「智能体」这类每个条目都有的词 */
const STOP_BIGRAMS = new Set([
  "帮忙",
  "助手",
  "智能",
  "能体",
  "做个",
  "可以",
  "怎么",
  "什么",
  "如何",
  "需要",
  "想要",
  "东西",
  "一下",
  "能不",
  "不能",
]);

const ASCII_WORD = /[a-z0-9]+/g;
const CJK_RUN = /[㐀-鿿]+/g;

export function suggestTokens(query: string): string[] {
  const text = query.toLocaleLowerCase();
  const out = new Set<string>();
  for (const word of text.match(ASCII_WORD) ?? []) {
    if (word.length >= 2) out.add(word);
  }
  for (const run of text.match(CJK_RUN) ?? []) {
    for (let i = 0; i + 1 < run.length; i++) {
      const pair = run.slice(i, i + 2);
      if (STOP_BIGRAMS.has(pair)) continue;
      if (STOP_CHARS.has(pair[0] as string) || STOP_CHARS.has(pair[1] as string)) continue;
      out.add(pair);
    }
  }
  return [...out];
}

const WEIGHTS = { name: 5, starters: 3, description: 2, category: 2 } as const;

function scoreDoc(tokens: readonly string[], doc: SuggestDoc): number {
  const fields: [string, number][] = [
    [doc.name.toLocaleLowerCase(), WEIGHTS.name],
    [doc.starters.join("\n").toLocaleLowerCase(), WEIGHTS.starters],
    [doc.description.toLocaleLowerCase(), WEIGHTS.description],
    [doc.category.toLocaleLowerCase(), WEIGHTS.category],
  ];
  let score = 0;
  for (const token of tokens) {
    let best = 0;
    for (const [text, weight] of fields) {
      if (weight > best && text.includes(token)) best = weight;
    }
    score += best;
  }
  return score;
}

/** 按分数取前 limit 个;一个词都没命中的不推荐。 */
export function rankSuggestions(
  query: string,
  docs: readonly SuggestDoc[],
  limit: number,
): Suggestion[] {
  const tokens = suggestTokens(query);
  if (tokens.length === 0) return [];
  return docs
    .map((doc) => ({ doc, score: scoreDoc(tokens, doc) }))
    .filter((x) => x.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.doc.mine) - Number(a.doc.mine) ||
        b.doc.useCount - a.doc.useCount ||
        a.doc.name.localeCompare(b.doc.name) ||
        a.doc.id.localeCompare(b.doc.id),
    )
    .slice(0, limit)
    .map(({ doc, score }) => ({ id: doc.id, score }));
}
