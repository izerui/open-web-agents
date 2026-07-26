export interface ApiKeyRecord {
  id: string;
  ownerId: string;
  /** 绑定到具体助手则只能调该助手;为空是账户级 key。 */
  assistantId?: string;
  name?: string;
  createdAt: number;
  lastUsedAt?: number;
}

export interface NewApiKey {
  id: string;
  ownerId: string;
  assistantId?: string;
  name?: string;
  /** 已哈希;明文绝不入库。 */
  hashedKey: string;
}

export interface ApiKeyRepo {
  create(k: NewApiKey): Promise<ApiKeyRecord>;
  /** 按哈希查找 —— 调用方传明文,上层负责哈希后再查。 */
  findByHash(hashedKey: string): Promise<ApiKeyRecord | null>;
  list(ownerId: string): Promise<ApiKeyRecord[]>;
  revoke(id: string): Promise<void>;
  touch(id: string, at: number): Promise<void>;
}
