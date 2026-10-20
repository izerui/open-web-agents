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
  /** 工作目录被自动清理的时刻(长期未活动);之前生成的文件已不在 */
  workspacePurgedAt?: number;
  /** 锁定的智能体版本;没有 = 跟随草稿 */
  agentVersion?: number;
  /** 这个会话实际运行的模型(按锁定版本或草稿解析,服务端给出) */
  model?: string;
}

export interface AgentSummary {
  id: string;
  name: string;
  icon?: string;
  description?: string;
  config: {
    /** 别名或模型目录 id;显示时换成模型名与售价 */
    model?: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    starters?: string[];
  };
  /** 结果回调地址(仅所有者与管理员可见) */
  webhookUrl?: string;
  /** 当前发布的版本;null = 从未发布(所有入口跑草稿) */
  publishedVersion?: number | null;
  /** 草稿是否有未发布的修改(仅能修改的人可见) */
  hasUnpublishedChanges?: boolean;
  /** 调用方默认拿到的契约;null = 从未发布,调用跑草稿 */
  published?: {
    version: number;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
  } | null;
  /** 是否已公开分享 */
  isPublic?: boolean;
  /** 当前用户能否修改 */
  canWrite?: boolean;
  /** 当前用户能否查看与设置 webhook(仅所有者与管理员) */
  canManageWebhook?: boolean;
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
  /** 客户端创建的稳定标识；runId 回来前后、切换视图时都不能靠数组下标定位。 */
  localId?: string;
  prompt: string;
  events: AgentEvent[];
  running: boolean;
  /** 该轮对应的运行 id;分支重跑要用它当分叉点。 */
  runId?: string;
  /** 从哪一轮分叉而来,界面显示分支标记。 */
  branchedFrom?: string;
  /** 该轮开始运行的时间(ISO 时间戳),用于计时标签。 */
  startedAt?: string;
}
