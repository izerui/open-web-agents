import type { AgentConfig } from "@/lib/modules/agent/domain/config";

export interface Agent {
  id: string;
  /** 创建者。授权判定的基准 —— owner 恒有全权。 */
  ownerId: string;
  name: string;
  icon?: string;
  description?: string;
  config: AgentConfig;
  /** 配了就在运行终态推一次结果回调。 */
  webhookUrl?: string;
  /**
   * 当前发布的版本号;undefined = 从未发布,所有入口都用草稿。
   * 只读:由 AgentVersionRepo 维护,upsert 不会改它。
   */
  publishedVersion?: number;
  /** 已发布版本的内容摘要,用于判断草稿是否有未发布修改。只读,同上。 */
  publishedHash?: string;
  /** 内置智能体上次由平台写入定义后的内容摘要(见 builtin-seed.ts)。只读:upsert 不改它。 */
  seedHash?: string;
}

/** 发布时冻结下来的内容:名称、说明与完整配置。webhookUrl 属于运维设置,不进版本。 */
export interface AgentSnapshot {
  name: string;
  icon?: string;
  description?: string;
  config: AgentConfig;
}

export interface AgentVersion extends AgentSnapshot {
  agentId: string;
  version: number;
  contentHash: string;
  note?: string;
  createdBy: string;
  createdAt: number;
}

/** 版本仓储。发布与回滚都会移动智能体的发布指针(publishedVersion / publishedHash)。 */
export interface AgentVersionRepo {
  /**
   * 把快照存为下一个版本号,并把发布指针指向它。版本号分配与指针移动必须原子 ——
   * 两个人同时点发布,不能拿到同一个版本号,也不能让指针指向别人那一版。
   */
  publish(
    agentId: string,
    snapshot: AgentSnapshot,
    meta: { contentHash: string; note?: string; createdBy: string },
  ): Promise<AgentVersion>;
  get(agentId: string, version: number): Promise<AgentVersion | null>;
  /** 按版本号倒序;不含 config,列表用。 */
  list(agentId: string): Promise<Omit<AgentVersion, "config">[]>;
  /** 一次取多个智能体当前发布的版本(列表页避免 N+1)。 */
  getMany(keys: { agentId: string; version: number }[]): Promise<AgentVersion[]>;
  /** 回滚:把发布指针指回一个已存在的版本。 */
  activate(agentId: string, version: number, contentHash: string): Promise<void>;
}

/** 列表过滤:归属于 ownerId 的,或 id 在 ids 里的(两者取并集)。 */
export interface AgentListFilter {
  ownerId?: string;
  ids?: string[];
}

export interface AgentRepo {
  get(id: string): Promise<Agent | null>;
  /**
   * 列出智能体。
   *
   * 【过滤必须下推到查询】曾经只有无参 list():取全库最新 200 条,路由再在内存里按可见性过滤。
   * 平台上的智能体一过 200,内置的公开智能体就被挤出那 200 条 —— 新用户的列表是空的,
   * 工作台输入框直接禁用;数据都在,能看到什么取决于【别人】建了多少。
   * 不传过滤条件仍是"最新 200 条",只给管理视图用。
   */
  list(filter?: AgentListFilter): Promise<Agent[]>;
  /** 每个所有者名下的智能体数量(管理页统计用,不受列表条数上限影响)。 */
  countByOwner(): Promise<Map<string, number>>;
  upsert(a: Agent): Promise<Agent>;
  /** 记下内置智能体的种子摘要。 */
  setSeedHash(id: string, hash: string): Promise<void>;
  /**
   * 软删除:之后 get / list / countByOwner 都当它不存在。返回是否删除了(已删除或不存在为 false)。
   * 行保留,历史会话与运行记录照常显示名称;id 不能被复用(见 idTaken)。
   */
  softDelete(id: string, at: number): Promise<boolean>;
  /** 这个 id 是否已被占用(含已删除的)—— 新建时用,防止撞上已删除的智能体。 */
  idTaken(id: string): Promise<boolean>;
}
