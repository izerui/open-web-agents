import type { AgentEvent } from "@/lib/shared";

export interface SessionSummary {
  id: string;
  agentId: string;
  workspaceDir: string;
  title?: string;
  createdAt: number;
  /**
   * 跑过的轮次数。只有列表接口会聚合出来 ——
   * 新建会话的 POST 响应里没有,所以是可选的。
   */
  runCount?: number;
  /** 最后一次发起运行的时间;一轮都没跑过时等于创建时间。 */
  lastActiveAt?: number;
}

export interface AgentSummary {
  id: string;
  name: string;
  icon?: string;
  description?: string;
  config: { outputSchema?: Record<string, unknown> };
  /** 是否已公开分享 */
  isPublic?: boolean;
  /** 当前用户能否修改 */
  canWrite?: boolean;
}

export interface FileNode {
  path: string;
  name: string;
  type: "file" | "dir";
  size?: number;
  mtime?: number;
}

export interface FilePreview {
  path: string;
  mime: string;
  size: number;
  text: string | null;
  truncated: boolean;
}

export interface Turn {
  prompt: string;
  events: AgentEvent[];
  running: boolean;
  /** 该轮对应的运行 id;分支重跑要用它当分叉点。 */
  runId?: string;
  /** 从哪一轮分叉而来,界面显示分支标记。 */
  branchedFrom?: string;
}
