import type { ModelAlias } from "@/lib/shared";

/** 会话 = 项目 = 工作目录,一对一。 */
export interface Session {
  id: string;
  agentId: string;
  /** 人用时的归属用户;归属校验靠它。 */
  ownerId?: string;
  /** 系统 invoke 时发起该会话的 API Key;归属校验靠它。 */
  callerApiKeyId?: string;
  workspaceDir: string;
  /** 上一轮 SDK session id,多轮 resume 用。 */
  sdkSessionId?: string;
  title?: string;
  /** 会话级凭证覆盖(三级链的中间层)。 */
  baseUrl?: string;
  key?: string;
  model?: ModelAlias;
  createdAt: number;
}

export interface NewSession {
  id: string;
  agentId: string;
  workspaceDir: string;
  title?: string;
  ownerId?: string;
  callerApiKeyId?: string;
}

export interface SessionRepo {
  create(s: NewSession): Promise<Session>;
  get(id: string): Promise<Session | null>;
  /**
   * 列出会话。
   *
   * 【归属过滤必须下推到查询】—— 曾经是无参 list() 取全局最新 100 条,路由拿到之后
   * 才按归属过滤。于是只要别的租户(或一把 invoke key)新建了 100 个会话,
   * 用户打开自己的列表就是空的:数据没丢,但界面完全不可达,能看到几条取决于
   * 【别人】的活跃度。没有游标、没有截断提示,纯静默失效。
   */
  list(filter?: { ownerId?: string; callerApiKeyId?: string }): Promise<Session[]>;
  /** 每轮结束后记下 SDK session id,供下一轮 resume。 */
  setSdkSessionId(id: string, sdkSessionId: string): Promise<void>;
}
