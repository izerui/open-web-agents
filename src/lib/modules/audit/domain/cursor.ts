/** 审计列表的键集游标:(时间, id),两个仓储实现共用。 */
export function encodeAuditCursor(e: { at: number; id: string }): string {
  return Buffer.from(`${e.at}:${e.id}`, "utf8").toString("base64url");
}

export function decodeAuditCursor(c: string): { at: number; id: string } | null {
  try {
    const [ts, id] = Buffer.from(c, "base64url").toString("utf8").split(":");
    const at = Number(ts);
    return id && Number.isFinite(at) ? { at, id } : null;
  } catch {
    return null;
  }
}
