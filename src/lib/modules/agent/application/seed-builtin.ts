// 启动时写入一个内置智能体(判定规则见 domain/builtin-seed.ts)。

import { type SeedDecision, decideSeed } from "@/lib/modules/agent/domain/builtin-seed";
import { contentHash, snapshotOf } from "@/lib/modules/agent/domain/release";
import type { Agent, AgentRepo } from "@/lib/modules/agent/ports";

export interface SeedBuiltinDeps {
  agents: Pick<AgentRepo, "withRowLock">;
  /** 测试用的暂停点:判定之后 / 写入定义之后、读回之前(都在行锁事务里) */
  pauseAt?: (point: "decided" | "written") => Promise<void>;
  /** 首次写入时授予所有人只读 —— 内置智能体归 system 所有,不授权新用户就看不到它 */
  grantPublicRead(): Promise<void>;
  warn?(message: string): void;
}

export async function seedBuiltin(
  deps: SeedBuiltinDeps,
  definition: Agent,
): Promise<SeedDecision | "deleted"> {
  /*
   * 读取、判定、写定义、读回、记摘要都在同一个行锁事务里(见 AgentRepo.withRowLock)。
   * 不锁的话有两个窗口会让管理员的修改丢掉:
   *   - 判定"没人改过"之后、写定义之前,管理员保存 → 随后被定义覆盖
   *   - 写定义之后、读回之前,管理员保存 → 管理员的内容被读回当成种子摘要,
   *     下次启动又把它当成"平台写入后没人改过"而覆盖
   * 锁住之后管理员的保存要等播种提交:要么播种先读到它(判为改过、保留),
   * 要么它排在播种之后落库(内容与摘要不符,下次判为改过、保留)。
   */
  const decision = await deps.agents.withRowLock(definition.id, async (agents) => {
    const existing = await agents.get(definition.id);
    // 被删除过(id 仍占用):尊重删除,不复活
    if (!existing && (await agents.idTaken(definition.id))) return "deleted" as const;

    const currentHash = existing ? contentHash(snapshotOf(existing)) : "";
    const d = decideSeed(
      existing ? { contentHash: currentHash, seedHash: existing.seedHash } : null,
      contentHash(snapshotOf(definition)),
    );
    await deps.pauseAt?.("decided");
    if (d === "keep-modified" || d === "keep-unknown") return d;
    if (d === "adopt") {
      // 内容就是代码里的定义:不写内容,只记下摘要,之后按"没人改过就升级"跟踪
      await agents.setSeedHash(definition.id, currentHash);
      return d;
    }
    // 运维设置(回调地址)不属于定义:升级时沿用原值
    await agents.upsert({
      ...definition,
      ...(existing?.webhookUrl ? { webhookUrl: existing.webhookUrl } : {}),
    });
    await deps.pauseAt?.("written");
    const saved = await agents.get(definition.id);
    if (!saved) throw new Error(`内置智能体写入后读不回来:${definition.id}`);
    await agents.setSeedHash(definition.id, contentHash(snapshotOf(saved)));
    return d;
  });

  if (decision === "keep-modified") {
    (deps.warn ?? console.warn)(
      `[owa] 内置智能体「${definition.name}」(${definition.id})已被修改,保留现有内容,不升级到新版本的内置定义`,
    );
  } else if (decision === "keep-unknown") {
    (deps.warn ?? console.warn)(
      `[owa] 内置智能体「${definition.name}」(${definition.id})与当前内置定义不同,且无从判断是否被修改过(早于修改跟踪的数据),保留现有内容不覆盖`,
    );
  } else if (decision === "insert") {
    // 公开只读只在首次写入时授予:管理员之后若撤掉了,重启不该替他加回来
    await deps.grantPublicRead();
  }
  return decision;
}
