import type { SessionSummary } from "./types";

/**
 * 相对时间。侧栏一列会话如果只有标题,看不出哪条是刚才的、哪条是上周的;
 * 绝对时间戳又太长塞不进去,所以用相对说法。
 */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const diff = now - ts;

  // 时钟回拨或服务端时间略微超前时,diff 会是负数 —— 当作"刚刚"而不是"-3 分钟前"
  if (diff < 60_000) return "刚刚";

  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;

  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export type SessionBucket = "今天" | "昨天" | "最近 7 天" | "更早";

/** 从时间戳取当天零点,用来按【日历日】而不是【24 小时】分组。 */
function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 会话归入哪一档。
 *
 * 【为什么按日历日而不是时长】凌晨 1 点看昨天 23 点的会话,差了 2 小时,
 * 但人认为那是"昨天"。按 24 小时算会把它归进"今天",跟直觉相反。
 */
export function bucketOf(ts: number, now: number = Date.now()): SessionBucket {
  const today = startOfDay(now);
  const sessionDay = startOfDay(ts);

  // 未来时间(时钟偏差)按今天算,不该掉进"更早"
  if (sessionDay >= today) return "今天";

  const daysApart = Math.round((today - sessionDay) / 86_400_000);
  if (daysApart === 1) return "昨天";
  if (daysApart <= 7) return "最近 7 天";
  return "更早";
}

const BUCKET_ORDER: SessionBucket[] = ["今天", "昨天", "最近 7 天", "更早"];

/**
 * 按时间分组,组内新的在前。空组不返回 —— 只有一条会话时不该出现四个标题。
 */
/**
 * 排序与分档的依据:最后活动时间优先,回退到创建时间。
 *
 * 【为什么不用创建时间】一个上周建、今天还在用的会话,按创建时间会被埋在"更早"里,
 * 而用户找的正是"我刚才在弄的那个"。接口拿不到聚合时才退回创建时间。
 */
export function activityOf(s: SessionSummary): number {
  return s.lastActiveAt ?? s.createdAt;
}

export function groupSessions(
  sessions: SessionSummary[],
  now: number = Date.now(),
): { bucket: SessionBucket; sessions: SessionSummary[] }[] {
  const byBucket = new Map<SessionBucket, SessionSummary[]>();

  for (const s of sessions) {
    const bucket = bucketOf(activityOf(s), now);
    const list = byBucket.get(bucket);
    if (list) list.push(s);
    else byBucket.set(bucket, [s]);
  }

  return BUCKET_ORDER.filter((b) => byBucket.has(b)).map((bucket) => ({
    bucket,
    sessions: (byBucket.get(bucket) ?? []).sort((a, b) => activityOf(b) - activityOf(a)),
  }));
}
