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

export interface AgentRepo {
  get(id: string): Promise<Agent | null>;
  list(): Promise<Agent[]>;
  upsert(a: Agent): Promise<Agent>;
  delete?(id: string): Promise<void>;
}
