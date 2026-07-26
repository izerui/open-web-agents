import type { ModelAlias } from "@/lib/shared";

/** 会话 = 项目 = 工作目录,一对一。 */
export interface Session {
  id: string;
  assistantId: string;
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
  assistantId: string;
  workspaceDir: string;
  title?: string;
}

export interface SessionRepo {
  create(s: NewSession): Promise<Session>;
  get(id: string): Promise<Session | null>;
  list(): Promise<Session[]>;
  /** 每轮结束后记下 SDK session id,供下一轮 resume。 */
  setSdkSessionId(id: string, sdkSessionId: string): Promise<void>;
}
