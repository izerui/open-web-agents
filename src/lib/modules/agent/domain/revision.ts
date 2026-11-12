import type { Agent } from "../ports";
import { designHash } from "./design";

/**
 * 智能体草稿的版本标记:表单管理的内容(名称、头像、描述、回调地址、配置)的哈希。
 *
 * 【为什么要有】构建页停顿 800ms 就整份自动保存。没有版本检查时,一个放了很久的标签页
 * 碰一下任意字段,就会把别的标签页、协作者或智能体设计器刚写进去的改动全部改回去,而且没有提示。
 * 保存时带上读到的 revision,和库里当前的对不上就拒绝(409 stale_draft)。
 *
 * 【为什么不用 updated_at】那一列只到秒,同一秒里的两次保存分不出先后;内容哈希没有这个问题。
 */
export function agentRevision(
  a: Pick<Agent, "name" | "icon" | "description" | "webhookUrl" | "config">,
): string {
  return designHash({
    name: a.name,
    icon: a.icon ?? null,
    description: a.description ?? null,
    webhookUrl: a.webhookUrl ?? null,
    config: a.config,
  }).slice(0, 24);
}
