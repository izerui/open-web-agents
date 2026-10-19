// 版本与发布用例:发布、回滚、载入草稿,以及"这次运行该用哪一版"。
//
// 规则:
// - agents 表里的那一行永远是【草稿】。构建器、AI 设计师只改草稿。
// - 发布 = 把草稿整份快照成新版本,并把发布指针指向它。
// - 回滚 = 把发布指针指回某个旧版本(不新建版本,秒级生效)。
// - 对外入口(接口调用、API Key 会话)默认跑发布指针指向的版本;
//   从未发布过的智能体跑草稿 —— 发布功能上线前创建的智能体行为不变。

import { contentHash, hasUnpublishedChanges, snapshotOf } from "@/lib/modules/agent/domain/release";
import type {
  Agent,
  AgentRepo,
  AgentSnapshot,
  AgentVersion,
  AgentVersionRepo,
} from "@/lib/modules/agent/ports";
import { BrandedError } from "@/lib/shared";

/** 指定的版本不存在。路由翻成 404。 */
export class VersionNotFound extends BrandedError {
  static readonly brand = Symbol.for("owa.error.VersionNotFound");
  constructor(
    readonly agentId: string,
    readonly version: number,
  ) {
    super(`agent ${agentId} 没有版本 v${version}`);
    this.name = "VersionNotFound";
  }
}

/** 草稿与当前发布版本完全相同,没有可发布的内容。路由翻成 409。 */
export class NothingToPublish extends BrandedError {
  static readonly brand = Symbol.for("owa.error.NothingToPublish");
  constructor(readonly version: number) {
    super(`草稿与已发布的 v${version} 相同,无需重复发布`);
    this.name = "NothingToPublish";
  }
}

/** 一次运行实际使用的内容。version 为 null = 草稿。 */
export interface Release extends AgentSnapshot {
  version: number | null;
}

export class AgentReleases {
  constructor(
    private readonly agents: Pick<AgentRepo, "get" | "upsert">,
    private readonly versions: AgentVersionRepo,
  ) {}

  async publish(agent: Agent, by: string, note?: string): Promise<AgentVersion> {
    const snapshot = snapshotOf(agent);
    const hash = contentHash(snapshot);
    if (agent.publishedVersion !== undefined && hash === agent.publishedHash) {
      throw new NothingToPublish(agent.publishedVersion);
    }
    return this.versions.publish(agent.id, snapshot, {
      contentHash: hash,
      note: note?.trim().slice(0, 512) || undefined,
      createdBy: by,
    });
  }

  /** 回滚(或前滚):把发布指针指向一个已有版本。 */
  async activate(agentId: string, version: number): Promise<AgentVersion> {
    const v = await this.versions.get(agentId, version);
    if (!v) throw new VersionNotFound(agentId, version);
    await this.versions.activate(agentId, version, v.contentHash);
    return v;
  }

  /**
   * 把某个版本载入草稿,在它的基础上继续改。不影响已发布的版本。
   * webhookUrl 与归属不属于版本内容,保持草稿原值。
   */
  async restoreToDraft(agent: Agent, version: number): Promise<Agent> {
    const v = await this.versions.get(agent.id, version);
    if (!v) throw new VersionNotFound(agent.id, version);
    return this.agents.upsert({
      ...agent,
      name: v.name,
      icon: v.icon,
      description: v.description,
      config: structuredClone(v.config),
    });
  }

  /**
   * 解析这次运行用哪一版:
   * - 显式指定 → 必须存在,否则 VersionNotFound;
   * - 否则用发布指针;从未发布 → 草稿。
   */
  async resolve(agent: Agent, requested?: number): Promise<Release> {
    const target = requested ?? agent.publishedVersion;
    if (target === undefined) return { ...snapshotOf(agent), version: null };
    const v = await this.versions.get(agent.id, target);
    if (!v) throw new VersionNotFound(agent.id, target);
    return {
      name: v.name,
      icon: v.icon,
      description: v.description,
      config: v.config,
      version: v.version,
    };
  }

  /** 按版本号取内容(会话已锁定版本时入队用)。 */
  async at(agent: Agent, version: number | undefined): Promise<Release> {
    if (version === undefined) return { ...snapshotOf(agent), version: null };
    return this.resolve(agent, version);
  }

  /** 列表页:一次取齐各智能体当前发布的版本。 */
  async publishedOf(list: Agent[]): Promise<Map<string, AgentVersion>> {
    const keys = list
      .filter((a) => a.publishedVersion !== undefined)
      .map((a) => ({ agentId: a.id, version: a.publishedVersion as number }));
    const found = await this.versions.getMany(keys);
    return new Map(found.map((v) => [v.agentId, v]));
  }

  list(agentId: string) {
    return this.versions.list(agentId);
  }

  get(agentId: string, version: number) {
    return this.versions.get(agentId, version);
  }

  hasUnpublishedChanges(agent: Agent): boolean {
    return hasUnpublishedChanges(agent);
  }
}
