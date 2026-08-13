export interface ApiKeyRecord {
  id: string;
  ownerId: string;
  /** 绑定到具体智能体则只能调该智能体;为空是账户级 key。 */
  agentId?: string;
  name?: string;
  createdAt: number;
  lastUsedAt?: number;
}

export interface NewApiKey {
  id: string;
  ownerId: string;
  agentId?: string;
  name?: string;
  /** 已哈希;明文绝不入库。 */
  hashedKey: string;
}

export interface ApiKeyRepo {
  create(k: NewApiKey): Promise<ApiKeyRecord>;
  /** 按哈希查找 —— 调用方传明文,上层负责哈希后再查。 */
  findByHash(hashedKey: string): Promise<ApiKeyRecord | null>;
  /** 按 id 取 —— 吊销前必须先查归属,否则任何人都能删别人的 key。 */
  get(id: string): Promise<ApiKeyRecord | null>;
  list(ownerId: string): Promise<ApiKeyRecord[]>;
  revoke(id: string): Promise<void>;
  touch(id: string, at: number): Promise<void>;
}
