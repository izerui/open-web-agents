// 内置智能体(默认智能体、AI 智能体设计师)启动时怎么写入。纯逻辑。
//
// 【为什么不再每次覆盖】曾经每次启动都把代码里的定义整份覆盖回去 —— 管理员对内置智能体的
// 提示词、配置所做的修改,下次重启全部丢失,而且没有任何提示。
// 【为什么也不能只写一次】代码里的定义会随版本改进(设计师的提示词尤其如此),
// 只在首次写入的话,已有部署永远拿不到改进。
//
// 所以:每次写入定义后记下"写入后的内容摘要"(种子摘要)。启动时当前内容与它一致 =
// 没人改过,升级到代码里的定义;不一致 = 管理员改过,保留并告警。
// 摘要取【写入后读回】的内容,而不是代码里的定义 —— 存取过程的规整(空值、字段拆分)
// 不会被误判成"有人改过"。

export type SeedDecision =
  /** 不存在:写入定义 */
  | "insert"
  /** 没被改过(或旧数据没有种子摘要):升级到代码里的定义 */
  | "upgrade"
  /** 被人改过:保留不动 */
  | "keep-modified";

export function decideSeed(
  existing: { contentHash: string; seedHash?: string } | null,
): SeedDecision {
  if (!existing) return "insert";
  // 旧数据(引入种子摘要之前)无从判断:按此前的行为升级一次,之后开始跟踪
  if (!existing.seedHash) return "upgrade";
  return existing.contentHash === existing.seedHash ? "upgrade" : "keep-modified";
}
