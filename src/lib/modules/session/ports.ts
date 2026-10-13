import type { ModelAlias } from "@/lib/shared";

/** 会话从哪个入口来。决定审批怎么走、结果是否推 webhook、在哪个列表里展示。 */
export type SessionSource = "web" | "api" | "invoke" | "embed";

/** active 正常 / archived 归档(列表默认不显示) / deleted 已删除(视同不存在)。 */
export type SessionStatus = "active" | "archived" | "deleted";

/** 会话 = 项目 = 工作目录,一对一。 */
export interface Session {
  id: string;
  agentId: string;
  /** 人用时的归属用户;归属校验靠它。 */
  ownerId?: string;
  /** 系统 invoke 时发起该会话的 API Key;归属校验靠它。 */
  callerApiKeyId?: string;
  /**
   * 计费归属账号:花费记给谁、额度按谁算、用谁自带的模型凭证。
   * 与 ownerId 分开 —— API Key / embed 会话没有人用归属,但花费必须有主。
   */
  billingUserId?: string;
  workspaceDir: string;
  /** 上一轮 SDK session id,多轮 resume 用。 */
  sdkSessionId?: string;
  title?: string;
  /** 无人值守(接口 invoke)。决定碰到需要人确认的关口时是等人还是直接放行。 */
  unattended?: boolean;
  source: SessionSource;
  status: SessionStatus;
  /** 设计会话的目标智能体。 */
  designTargetAgentId?: string;
  /** 锁定的智能体版本;undefined = 跟随草稿。建会话时定下,整个会话不变。 */
  agentVersion?: number;
  /** 工作目录被 GC 整体清理的时刻(ms);之前生成的文件已不在。 */
  workspacePurgedAt?: number;
  /** 最近一次有人要写工作目录的时刻(运行启动、文件上传)。 */
  workspaceTouchedAt?: number;
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
  /** 不传则取 ownerId。API Key / embed 入口必须显式传签发 key 的账号。 */
  billingUserId?: string;
  /** 无人值守(接口 invoke)。不传则默认有人。 */
  unattended?: boolean;
  /** 不传:无人值守即 invoke,否则 web。 */
  source?: SessionSource;
  designTargetAgentId?: string;
  /** 锁定的智能体版本;不传 = 跟随草稿。 */
  agentVersion?: number;
}

export interface SessionListFilter {
  ownerId?: string;
  callerApiKeyId?: string;
  billingUserId?: string;
  /** 只列这些入口来的会话。 */
  sources?: SessionSource[];
  /** 是否包含归档的会话。已删除的永远不列。 */
  includeArchived?: boolean;
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
  list(filter?: SessionListFilter): Promise<Session[]>;
  /** 每轮结束后记下 SDK session id,供下一轮 resume。 */
  setSdkSessionId(id: string, sdkSessionId: string): Promise<void>;
  /**
   * 工作目录的会话级互斥协议(防止 GC 与新运行 / 上传赛跑而丢文件)。
   *
   * 写工作目录的一方(运行启动、文件上传)在动手前调用 prepareWorkspace:锁住会话行,
   * 记下 workspaceTouchedAt = 现在,并在锁内确保目录存在。
   * GC 动手时调用 reclaimWorkspace:锁住同一行,在锁内重新判定条件,成立才执行 op
   * (把目录或中间产物【改名挪走】),purge 时同时记下 workspacePurgedAt;op 完成后才放锁。
   *
   * 两边在同一把行锁上串行:写方在前,GC 在锁内看到刚记下的使用时刻而放弃;
   * GC 在前,写方等改名完成后再建空目录。没有"判定之后、动手之前"的窗口。
   */
  prepareWorkspace(id: string, opts: { nowMs: number }, ensure: () => Promise<void>): Promise<void>;
  /**
   * 条件(全部在会话行锁内判定):
   * - 会话创建于 quietSinceMs 之前,且 workspaceTouchedAt 为空或早于它;
   * - 没有在 quietSinceMs 之后有过活动的运行,没有租约有效的运行;
   * - kind = "clean"(清中间产物)还要求没有未结束的运行。
   * 返回是否执行了 op。op 抛错则整体回滚(不记清理时刻)。
   */
  reclaimWorkspace(
    id: string,
    opts: { quietSinceMs: number; nowMs: number; kind: "purge" | "clean" },
    op: () => Promise<void>,
  ): Promise<boolean>;
  /** 删除一条还没有任何运行的会话(入队失败或幂等冲突时回滚刚建的会话)。 */
  delete(id: string): Promise<void>;
  /** 改标题 / 归档 / 软删除。只改传进来的字段。 */
  update(
    id: string,
    patch: { title?: string; status?: SessionStatus; designTargetAgentId?: string },
  ): Promise<void>;
}
