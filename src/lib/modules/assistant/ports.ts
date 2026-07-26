import type { AssistantConfig } from "@/lib/modules/assistant/domain/config";

export interface Assistant {
  id: string;
  name: string;
  icon?: string;
  description?: string;
  config: AssistantConfig;
}

export interface AssistantRepo {
  get(id: string): Promise<Assistant | null>;
  list(): Promise<Assistant[]>;
  upsert(a: Assistant): Promise<Assistant>;
}
