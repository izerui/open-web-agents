export interface ApiKeyRecord {
  id: string;
  ownerId: string;
  /** 绑定到具体智能体则只能调该智能体;为空是账户级 key。 */
  agentId?: string;
  name?: string;
  /** 每分钟新调用上限;undefined = 平台默认。 */
  rateLimitPerMinute?: number;
  /** 到期时刻(ms);undefined = 不过期 */
  expiresAt?: number;
  createdAt: number;
  lastUsedAt?: number;
}

export interface NewApiKey {
  id: string;
  ownerId: string;
  agentId?: string;
  name?: string;
  rateLimitPerMinute?: number;
  expiresAt?: number;
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
  /** 调整每分钟上限;null = 恢复平台默认。 */
  setRateLimit(id: string, perMinute: number | null): Promise<void>;
  /** 设到期时刻;null = 不过期。 */
  setExpiry(id: string, at: number | null): Promise<void>;
  touch(id: string, at: number): Promise<void>;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** 被拒时还要等多久(ms)。 */
  retryAfterMs: number;
  /** 本窗口还剩几次(被拒时为 0)。 */
  remaining: number;
  /** 本窗口还有多久重置(ms)。 */
  resetMs: number;
}

/** 固定窗口限流。实现须在后端不可用时放行(见 RedisRateLimiter)。 */
export interface RateLimiter {
  hit(key: string, limit: number, windowMs: number): Promise<RateLimitVerdict>;
}
