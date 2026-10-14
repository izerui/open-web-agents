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
  /** 上次写入后没被改过:升级到代码里的定义 */
  | "upgrade"
  /** 旧数据(没有种子摘要)且内容就是代码里的定义:不写内容,只记下摘要开始跟踪 */
  | "adopt"
  /** 被人改过:保留不动 */
  | "keep-modified"
  /** 旧数据且内容与代码里的定义不同:无从判断是不是被改过,保守保留 */
  | "keep-unknown";

export function decideSeed(
  existing: { contentHash: string; seedHash?: string } | null,
  /** 代码里这份定义的内容摘要 */
  definitionHash: string,
): SeedDecision {
  if (!existing) return "insert";
  if (!existing.seedHash) {
    // 引入种子摘要之前的旧数据:看不出是不是被改过。"不知道"不能当成"没人改过" ——
    // 曾经直接升级,于是装上这次修复后的第一次重启,仍会把管理员改过的内容整份覆盖掉
    return existing.contentHash === definitionHash ? "adopt" : "keep-unknown";
  }
  return existing.contentHash === existing.seedHash ? "upgrade" : "keep-modified";
}
