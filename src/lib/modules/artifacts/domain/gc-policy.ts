// 工作空间回收策略。纯逻辑(只做判定,不删文件),便于穷举单测。
//
// 两层回收(设计文稿 §13.6):
// ① 完成即清中间产物 —— 会话还留着,但临时文件不再占地
// ② 保留期过后清整个目录 —— 会话彻底归档
//
// 判定与执行分离的原因:删文件不可逆,策略必须能在不碰磁盘的前提下被测穷。

export interface WorkspaceInfo {
  sessionId: string;
  /** 会话最后活动时间(ms)。 */
  lastActiveAt: number;
  /** 会话是否已结束(所有 run 落终态)。 */
  finished: boolean;
}

export interface GcPolicy {
  /** 结束多久后清中间产物。 */
  intermediateAfterMs: number;
  /** 最后活动多久后清整个目录。 */
  purgeAfterMs: number;
}

export type GcAction = "keep" | "clean-intermediate" | "purge";

export const DEFAULT_GC_POLICY: GcPolicy = {
  intermediateAfterMs: 60 * 60_000, // 1 小时
  purgeAfterMs: 7 * 24 * 60 * 60_000, // 7 天
};

/**
 * 判定某个工作空间该怎么处理。
 * 未结束的会话一律 keep —— 正在跑的任务绝不能被回收掉工作目录。
 */
export function decideGc(ws: WorkspaceInfo, policy: GcPolicy, now: number): GcAction {
  const age = now - ws.lastActiveAt;
  if (age >= policy.purgeAfterMs) return "purge";
  if (!ws.finished) return "keep";
  return age >= policy.intermediateAfterMs ? "clean-intermediate" : "keep";
}

/** 被视为中间产物的文件名模式 —— 只清明确的临时物,不动用户可能要的产出。 */
const INTERMEDIATE_PATTERNS = [
  /^\.cache$/,
  /^node_modules$/,
  /^__pycache__$/,
  /^\.venv$/,
  /\.tmp$/,
  /\.temp$/,
  /^tmp$/,
  /\.log$/,
  /\.pyc$/,
];

export function isIntermediate(name: string): boolean {
  return INTERMEDIATE_PATTERNS.some((re) => re.test(name));
}
