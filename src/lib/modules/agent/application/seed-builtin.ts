// 启动时写入一个内置智能体(判定规则见 domain/builtin-seed.ts)。

import { type SeedDecision, decideSeed } from "@/lib/modules/agent/domain/builtin-seed";
import { contentHash, snapshotOf } from "@/lib/modules/agent/domain/release";
import type { Agent, AgentRepo } from "@/lib/modules/agent/ports";

export interface SeedBuiltinDeps {
  agents: Pick<AgentRepo, "get" | "upsert" | "setSeedHash" | "idTaken">;
  /** 首次写入时授予所有人只读 —— 内置智能体归 system 所有,不授权新用户就看不到它 */
  grantPublicRead(): Promise<void>;
  warn?(message: string): void;
}

export async function seedBuiltin(
  deps: SeedBuiltinDeps,
  definition: Agent,
): Promise<SeedDecision | "deleted"> {
  const existing = await deps.agents.get(definition.id);
  // 被删除过(id 仍占用):尊重删除,不复活
  if (!existing && (await deps.agents.idTaken(definition.id))) return "deleted";

  const currentHash = existing ? contentHash(snapshotOf(existing)) : "";
  const decision = decideSeed(
    existing ? { contentHash: currentHash, seedHash: existing.seedHash } : null,
    contentHash(snapshotOf(definition)),
  );
  if (decision === "keep-modified") {
    (deps.warn ?? console.warn)(
      `[owa] 内置智能体「${definition.name}」(${definition.id})已被修改,保留现有内容,不升级到新版本的内置定义`,
    );
    return decision;
  }
  if (decision === "keep-unknown") {
    (deps.warn ?? console.warn)(
      `[owa] 内置智能体「${definition.name}」(${definition.id})与当前内置定义不同,且无从判断是否被修改过(早于修改跟踪的数据),保留现有内容不覆盖`,
    );
    return decision;
  }
  if (decision === "adopt") {
    // 内容就是代码里的定义:不写内容,只记下摘要,之后按"没人改过就升级"跟踪
    await deps.agents.setSeedHash(definition.id, currentHash);
    return decision;
  }

  // 运维设置(回调地址)不属于定义:升级时沿用原值
  const saved = await deps.agents.upsert({
    ...definition,
    ...(existing?.webhookUrl ? { webhookUrl: existing.webhookUrl } : {}),
  });
  await deps.agents.setSeedHash(definition.id, contentHash(snapshotOf(saved)));
  // 公开只读只在首次写入时授予:管理员之后若撤掉了,重启不该替他加回来
  if (decision === "insert") await deps.grantPublicRead();
  return decision;
}
