import type { AssistantConfig } from "@/lib/modules/assistant/domain/config";

export interface Assistant {
  id: string;
  /** 创建者。授权判定的基准 —— owner 恒有全权。 */
  ownerId: string;
  name: string;
  icon?: string;
  description?: string;
  config: AssistantConfig;
  /** 配了就在运行终态推一次结果回调。 */
  webhookUrl?: string;
}

export interface AssistantRepo {
  get(id: string): Promise<Assistant | null>;
  list(): Promise<Assistant[]>;
  upsert(a: Assistant): Promise<Assistant>;
  delete?(id: string): Promise<void>;
}
