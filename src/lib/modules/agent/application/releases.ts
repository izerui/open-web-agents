// 版本与发布用例:发布、回滚、载入草稿,以及"这次运行该用哪一版"。
//
// 规则:
// - agents 表里的那一行永远是【草稿】。构建器、AI 设计师只改草稿。
// - 发布 = 把草稿整份快照成新版本,并把发布指针指向它。
// - 发布前必须过门槛(PublishGate):草稿要有一次配置相同、用例相同、全部通过的评测,没有例外。
// - 回滚 = 把发布指针指回某个旧版本(不新建版本,秒级生效)。回滚不过门槛:旧版本当初已发布过。
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

/** 没过发布门槛(评测没有全部通过等)。路由翻成 409。 */
export class PublishBlocked extends BrandedError {
  static readonly brand = Symbol.for("owa.error.PublishBlocked");
  constructor(reason: string) {
    super(reason);
    this.name = "PublishBlocked";
  }
}

/**
 * 发布门槛:返回不能发布的原因,能发布返回 null。contentHash 是这次要发布的内容的摘要 ——
 * 判定的就是要冻结的这一份,不是另读一次草稿
 */
export interface PublishGate {
  blockReason(agentId: string, contentHash: string): Promise<string | null>;
}

/** 一次运行实际使用的内容。version 为 null = 草稿。 */
export interface Release extends AgentSnapshot {
  version: number | null;
}

export class AgentReleases {
  constructor(
    private readonly agents: Pick<AgentRepo, "get" | "upsert">,
    private readonly versions: AgentVersionRepo,
    /** 必填:没有绕过门槛的发布入口 */
    private readonly gate: PublishGate,
  ) {}

  async publish(agent: Agent, by: string, note?: string): Promise<AgentVersion> {
    const snapshot = snapshotOf(agent);
    const hash = contentHash(snapshot);
    if (agent.publishedVersion !== undefined && hash === agent.publishedHash) {
      throw new NothingToPublish(agent.publishedVersion);
    }
    const blocked = await this.gate.blockReason(agent.id, hash);
    if (blocked) throw new PublishBlocked(blocked);
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

  /**
   * 每个会话实际运行的模型引用:锁定版本的取那一版配置,否则取当前草稿 —— 与入队时
   * `at(agent, session.agentVersion)` 同一口径。智能体或版本已不存在的不给。
   */
  async modelsOf(
    sessions: { id: string; agentId: string; agentVersion?: number }[],
  ): Promise<Map<string, string>> {
    const pinned = sessions.filter((s) => s.agentVersion !== undefined);
    const versions = await this.versions.getMany(
      pinned.map((s) => ({ agentId: s.agentId, version: s.agentVersion as number })),
    );
    const byVersion = new Map(versions.map((v) => [`${v.agentId}:${v.version}`, v.config.model]));
    const draftIds = [
      ...new Set(sessions.filter((s) => s.agentVersion === undefined).map((s) => s.agentId)),
    ];
    const drafts = new Map<string, string>();
    for (const id of draftIds) {
      const agent = await this.agents.get(id);
      if (agent) drafts.set(id, agent.config.model);
    }
    const out = new Map<string, string>();
    for (const s of sessions) {
      const model =
        s.agentVersion !== undefined
          ? byVersion.get(`${s.agentId}:${s.agentVersion}`)
          : drafts.get(s.agentId);
      if (model) out.set(s.id, model);
    }
    return out;
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
