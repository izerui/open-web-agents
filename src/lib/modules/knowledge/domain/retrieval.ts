// 知识检索的纯逻辑:切块、分词、打分、选片段。零 IO,可穷举单测。
//
// 为什么先做关键词检索而不是向量库:
// 引入向量库要多一个基础设施依赖、要嵌入模型、要处理索引更新与一致性 ——
// 而多数企业知识库(产品手册、SOP、FAQ)的查询本就以术语命中为主,BM25 足够好用。
// 检索接口(retrieve)与实现解耦,将来换向量检索不动上层。
//
// 中文没有空格分词,故采用【英文按词 + 中文按字与二元组】的混合切分:
// 单字召回率高但噪声大,二元组能把"发票"这类词组当整体匹配,两者结合在没有
// 分词器的前提下效果最稳。

export interface Chunk {
  docId: string;
  docTitle: string;
  /** 片段在原文里的序号,便于定位。 */
  index: number;
  text: string;
}

export interface ScoredChunk extends Chunk {
  score: number;
}

/** 片段目标长度。太短丢上下文,太长挤占提示词预算。 */
const CHUNK_SIZE = 700;
const CHUNK_OVERLAP = 100;

/**
 * 把长文切成带重叠的片段。
 * 重叠是必要的 —— 否则正好跨越切点的句子会两边都检索不到。
 */
export function chunkText(text: string, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];

  const step = Math.max(1, size - overlap);
  const out: string[] = [];
  for (let i = 0; i < clean.length; i += step) {
    const piece = clean.slice(i, i + size).trim();
    if (piece) out.push(piece);
    if (i + size >= clean.length) break;
  }
  return out;
}

const CJK = /[一-鿿]/;

/**
 * 中文高频虚词,只对【单字】token 生效。
 *
 * 为什么必须有:单字召回高但噪声也大,而"的、了、是、在"这类字几乎出现在每一段中文里 ——
 * 于是任意两段毫不相干的中文都能匹配上,拿到一个不为零的分数。
 * 实测:问「量子纠缠的实验验证」,一篇讲差旅报销的文档能得 0.09 分,
 * 靠的全是一个「的」字。这类假分数在绝对阈值下侥幸被滤掉,换成相对阈值后就会浮上来
 * (最不相干的一批里"最不差的"照样过线)。
 *
 * 所以噪声要在源头去掉,而不是靠阈值去猜。二元组不受影响 —— 它本身就有区分度。
 */
const CJK_STOPWORDS = new Set([
  ..."的了是在和与及对为以之等着过们这那有不也就都而或被把从向很再更即将则由于所其此该另每各种个上下中",
]);

/**
 * 混合分词:英文/数字按词切,中文出单字 + 相邻二元组。
 * 全部小写化,便于大小写不敏感匹配。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();

  for (const m of lower.matchAll(/[a-z0-9_]+/g)) {
    if (m[0].length > 1) tokens.push(m[0]);
  }

  const cjk = [...lower].filter((c) => CJK.test(c));
  for (const c of cjk) {
    if (!CJK_STOPWORDS.has(c)) tokens.push(c);
  }
  for (let i = 0; i + 1 < cjk.length; i++) {
    const a = cjk[i] as string;
    const b = cjk[i + 1] as string;
    // 两个字都是虚词的组合(如"的是""在于")同样没有区分度
    if (CJK_STOPWORDS.has(a) && CJK_STOPWORDS.has(b)) continue;
    tokens.push(`${a}${b}`);
  }

  return tokens;
}

/** 文档频次统计,用于 IDF。 */
function documentFrequencies(chunks: Chunk[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const c of chunks) {
    for (const t of new Set(tokenize(c.text))) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  return df;
}

const K1 = 1.5;
const B = 0.75;

/**
 * BM25 打分。
 * 相比朴素词频,它做两件要紧的事:常见词降权(IDF)、长片段不因为字多就占便宜(长度归一)。
 */
export function scoreChunks(query: string, chunks: Chunk[]): ScoredChunk[] {
  if (chunks.length === 0) return [];

  const queryTokens = [...new Set(tokenize(query))];
  if (queryTokens.length === 0) return [];

  const df = documentFrequencies(chunks);
  const N = chunks.length;
  const lengths = chunks.map((c) => tokenize(c.text).length);
  const avgLen = lengths.reduce((a, b) => a + b, 0) / N || 1;

  return chunks.map((c, i) => {
    const tokens = tokenize(c.text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

    let score = 0;
    for (const q of queryTokens) {
      const f = tf.get(q);
      if (!f) continue;
      const n = df.get(q) ?? 0;
      // +0.5 平滑:即便某词出现在所有片段里,IDF 也不至于变成 0 或负数
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const norm = f * (K1 + 1);
      const denom = f + K1 * (1 - B + (B * (lengths[i] ?? 0)) / avgLen);
      score += idf * (norm / denom);
    }
    return { ...c, score };
  });
}

export interface RetrieveOptions {
  /** 最多返回几个片段。 */
  topK?: number;
  /** 绝对分数下限。显式传了就用它,否则走 relMinScore 的相对判定。 */
  minScore?: number;
  /** 相对下限:不低于本次最高分的这个比例。默认 0.25。 */
  relMinScore?: number;
  /** 注入提示词的总字数上限,防止挤爆上下文。 */
  maxChars?: number;
}

/**
 * 按查询选出最相关的片段。
 *
 * 命中不了就返回空 —— 塞一堆不相关的内容进提示词,比不塞更糟:
 * 既浪费预算,又会把模型往错误方向带。
 */
export function retrieve(
  query: string,
  chunks: Chunk[],
  opts: RetrieveOptions = {},
): ScoredChunk[] {
  const topK = opts.topK ?? 5;
  const maxChars = opts.maxChars ?? 6000;

  /**
   * 相关性下限必须是【相对】的。
   *
   * 曾经是固定的 0.1 绝对阈值。但 BM25 的 IDF 随词频上升而衰减,而智能体知识库
   * 按定义就是主题集中的语料 —— 同一批文档,分数会随语料规模整体下移。实测:
   *   语料 5 篇  → 最高分 0.559,命中 5
   *   语料 20 篇 → 最高分 0.155,命中 5
   *   语料 50 篇 → 最高分 0.064,命中 0   ← 全军覆没
   * 也就是【知识库越完善越检索不到】。而且返回空之后没有任何"未命中"信号,
   * 模型转而凭参数记忆作答,表面上一切正常。
   *
   * 改成"不低于本次最高分的若干比例":语料整体缩放时判定不变,
   * 而"最好的也只是勉强沾边"这种情况仍会被整体过滤 —— 原来的意图保住了。
   */
  const scored = scoreChunks(query, chunks)
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
  const top = scored[0]?.score ?? 0;
  // 显式传 minScore = 调用方明确要绝对阈值;否则用相对判定
  const cutoff = opts.minScore ?? top * (opts.relMinScore ?? 0.25);
  const ranked = scored.filter((c) => c.score >= cutoff);

  const out: ScoredChunk[] = [];
  let used = 0;
  for (const c of ranked) {
    if (out.length >= topK) break;
    if (used + c.text.length > maxChars) continue;
    out.push(c);
    used += c.text.length;
  }
  return out;
}

/** 把检索结果拼成注入提示词的文本块。空结果返回空串,调用方据此决定要不要注入。 */
export function formatContext(hits: ScoredChunk[]): string {
  if (hits.length === 0) return "";
  const parts = hits.map((h) => `【${h.docTitle} · 片段 ${h.index + 1}】\n${h.text}`);
  return [
    "以下是与用户问题相关的资料。回答时优先依据它们;资料没有提到的,如实说明而不要编造。",
    "",
    parts.join("\n\n---\n\n"),
  ].join("\n");
}
