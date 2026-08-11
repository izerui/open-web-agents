import type { ModelAlias } from "@/lib/shared";

export interface User {
  id: string;
  email: string;
  role: "admin" | "user";
  /** 用户级凭证覆盖(三级链中的 user 层)。 */
  defaultBaseUrl?: string;
  /** 已加密;取用前须经 SecretBox 解密。 */
  anthropicKeyEnc?: string;
  defaultModel?: ModelAlias;
  /** 禁用的账号不能登录,已登录的会话也立即失效。 */
  disabled: boolean;
  /** 月度花费上限(微美元)。undefined = 不限。 */
  monthlyQuotaMicroUsd?: number;
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
  findByEmail(email: string): Promise<(User & { passwordHash: string }) | null>;
  get(id: string): Promise<User | null>;
  count(): Promise<number>;
  /** 更新用户自带凭证。传 null 表示清除。 */
  setCredentials(
    id: string,
    v: { defaultBaseUrl?: string | null; anthropicKeyEnc?: string | null },
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
    v: { role?: "admin" | "user"; disabled?: boolean; monthlyQuotaMicroUsd?: number | null },
  ): Promise<void>;

  /** 当前管理员数量 —— 用来挡住"把最后一个管理员降级/禁用"。 */
  countAdmins(): Promise<number>;
}
