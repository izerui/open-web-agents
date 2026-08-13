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
}

export interface AgentRepo {
  get(id: string): Promise<Agent | null>;
  list(): Promise<Agent[]>;
  upsert(a: Agent): Promise<Agent>;
  delete?(id: string): Promise<void>;
}
