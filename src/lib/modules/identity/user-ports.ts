import type { ModelAlias } from "@/lib/shared";

export interface User {
  id: string;
  email: string;
  role: "admin" | "user";
  /** 用户级凭证覆盖(三级链中的 user 层)。 */
  defaultBaseUrl?: string;
  /** 已加密;取用前须经 SecretBox 解密。 */
  anthropicKeyEnc?: string;
  /** Webhook 签名密钥,已加密。该用户名下智能体的回调都用它签名。 */
  webhookSecretEnc?: string;
  /** 换密钥后的旧密钥(重叠期内仍签名)与重叠期结束时刻(ms) */
  webhookSecretPrevEnc?: string;
  webhookSecretPrevUntil?: number;
  defaultModel?: ModelAlias;
  /** 禁用的账号不能登录,已登录的会话也立即失效。 */
  disabled: boolean;
  /** 月度积分上限(微积分,十进制字符串)。undefined = 不限。 */
  monthlyLimitMicroCredits?: string;
  /**
   * 升级前配置的美元月度上限(微美元),只在还没按积分重新设置时存在。
   * 不擅自换算成积分:这类账号不受理运行,直到管理员按积分设置上限或明确设为不限。
   */
  legacyMonthlyLimitMicroUsd?: number;
  createdAt: number;
}

export interface NewUser {
  id: string;
  email: string;
  passwordHash: string;
  role?: "admin" | "user";
}

export interface UserRepo {
  create(u: NewUser): Promise<User>;
  /**
   * 自助注册:"是不是第一个用户"的判定与建号在同一个事务里,并发注册也只有一个成为管理员。
   * 第一个注册的成为 admin;不是第一个且 allowOthers=false(未开放注册)时不建号,返回 null。
   * 建号失败(如邮箱已存在)时整体回滚,不会出现"第一个的名额被占了却没有管理员"。
   */
  registerSelf(u: Omit<NewUser, "role">, opts: { allowOthers: boolean }): Promise<User | null>;
  findByEmail(email: string): Promise<(User & { passwordHash: string }) | null>;
  get(id: string): Promise<User | null>;
  count(): Promise<number>;
  /** 更新用户自带凭证与 webhook 签名密钥。传 null 表示清除,不传表示不动。 */
  setCredentials(
    id: string,
    v: {
      defaultBaseUrl?: string | null;
      anthropicKeyEnc?: string | null;
      webhookSecretEnc?: string | null;
      webhookSecretPrevEnc?: string | null;
      webhookSecretPrevUntil?: number | null;
    },
  ): Promise<void>;

  /**
   * 全部账号,按注册时间倒序。仅平台管理用。
   *
   * 【为什么不做分页】这是自托管平台的账号列表,量级是几十到几百;
   * 加分页要连带做搜索和排序才好用,而现在还没有那个需求。
   * 但也不能无上限 —— 给一个足够大的 limit,并让调用方知道被截断了。
   */
  listAll(limit?: number): Promise<User[]>;

  /**
   * 改角色 / 禁用状态 / 月度额度。只改传进来的那几项。
   * 【为什么合成一个方法】三者都是"平台对账号的管理动作",
   * 拆成三个方法会让 adapter 里出现三段几乎一样的 UPDATE。
   */
  adminUpdate(
    id: string,
    v: { role?: "admin" | "user"; disabled?: boolean; monthlyLimitMicroCredits?: string | null },
  ): Promise<void>;

  /** 当前管理员数量 —— 用来挡住"把最后一个管理员降级/禁用"。 */
  countAdmins(): Promise<number>;

  /** 改密码(传入已哈希的值)。 */
  setPasswordHash(id: string, passwordHash: string): Promise<void>;

  /** 按 id 取带密码哈希的记录(改密码时校验旧密码用)。 */
  getWithPassword(id: string): Promise<(User & { passwordHash: string }) | null>;
}
