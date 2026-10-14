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

  const decision = decideSeed(
    existing
      ? { contentHash: contentHash(snapshotOf(existing)), seedHash: existing.seedHash }
      : null,
  );
  if (decision === "keep-modified") {
    (deps.warn ?? console.warn)(
      `[owa] 内置智能体「${definition.name}」(${definition.id})已被修改,保留现有内容,不升级到新版本的内置定义`,
    );
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
