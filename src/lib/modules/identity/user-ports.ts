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
}
