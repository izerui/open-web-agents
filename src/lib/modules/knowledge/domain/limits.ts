// 知识库的容量上限与"哪些文档参与检索"的规则。纯逻辑。
//
// 【为什么要在写入时设上限】曾经列表取【最新】500 篇、检索取【最早】500 篇:
// 文档一过 500,新传的在列表里看得见却永远检索不到,最早的检索得到却在列表里消失 ——
// 没有报错,用户也无从知道哪些文档在起作用。
// 现在:写入时就拦住超限;列表与检索按同一个顺序、同一个上限判定"可检索";
// 上限之前写入的超额旧数据,列表里明确标为"不参与检索",而不是悄悄藏起来。

import { BrandedError } from "@/lib/shared";

export interface KnowledgeLimits {
  /** 每个智能体最多几篇文档 */
  maxDocs: number;
  /** 单篇最多字符数 */
  maxDocChars: number;
  /** 每个智能体全部文档合计最多字符数(每次运行要把它们切块检索,必须有界) */
  maxTotalChars: number;
}

export const KNOWLEDGE_LIMITS: KnowledgeLimits = {
  maxDocs: 500,
  maxDocChars: 200_000,
  maxTotalChars: 5_000_000,
};

export class KnowledgeLimitExceeded extends BrandedError {
  static readonly brand = Symbol.for("owa.error.KnowledgeLimitExceeded");
}

/** 新增一篇是否超限;返回人话原因,不超限返回 null。 */
export function limitViolation(
  current: { docs: number; chars: number },
  addChars: number,
  limits: KnowledgeLimits = KNOWLEDGE_LIMITS,
): string | null {
  return batchLimitViolation(current, [addChars], limits);
}

/** 一次新增多篇(一个文件切成的几篇要么都进、要么都不进)是否超限 */
export function batchLimitViolation(
  current: { docs: number; chars: number },
  addChars: number[],
  limits: KnowledgeLimits = KNOWLEDGE_LIMITS,
): string | null {
  if (addChars.some((n) => n > limits.maxDocChars)) {
    return `单篇文档过长(上限 ${limits.maxDocChars.toLocaleString()} 字),请拆分`;
  }
  const docs = addChars.length;
  const chars = addChars.reduce((a, b) => a + b, 0);
  if (current.docs + docs > limits.maxDocs) {
    if (docs > 1) {
      return `该智能体已有 ${current.docs} 篇文档,再加这 ${docs} 篇会超过上限 ${limits.maxDocs} 篇;请先删除不用的文档`;
    }
    return `该智能体已有 ${current.docs} 篇文档,达到上限 ${limits.maxDocs} 篇;请先删除不用的文档`;
  }
  if (current.chars + chars > limits.maxTotalChars) {
    return `该智能体的知识库合计将超过 ${limits.maxTotalChars.toLocaleString()} 字的上限;请先删除不用的文档`;
  }
  return null;
}
