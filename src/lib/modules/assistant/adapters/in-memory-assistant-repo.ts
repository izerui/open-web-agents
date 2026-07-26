import type { Assistant, AssistantRepo } from "@/lib/modules/assistant/ports";

/** 内存助手仓储。垂直切片先内置一个通用助手,构建器与 MySQL adapter 后续接入。 */
export class InMemoryAssistantRepo implements AssistantRepo {
  private items = new Map<string, Assistant>();

  constructor(seed: Assistant[] = []) {
    for (const a of seed) this.items.set(a.id, a);
  }

  async get(id: string): Promise<Assistant | null> {
    const a = this.items.get(id);
    return a ? structuredClone(a) : null;
  }

  async list(): Promise<Assistant[]> {
    return [...this.items.values()].map((a) => structuredClone(a));
  }

  async upsert(a: Assistant): Promise<Assistant> {
    this.items.set(a.id, structuredClone(a));
    return structuredClone(a);
  }
}
