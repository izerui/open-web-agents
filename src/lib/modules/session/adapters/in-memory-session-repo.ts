import type {
  NewSession,
  Session,
  SessionListFilter,
  SessionRepo,
  SessionStatus,
} from "@/lib/modules/session/ports";

/** 内存会话仓储。垂直切片先用它跑通,MySQL adapter 后续替换(端口不变)。 */
export class InMemorySessionRepo implements SessionRepo {
  private sessions = new Map<string, Session>();

  async create(s: NewSession): Promise<Session> {
    const session: Session = {
      ...s,
      billingUserId: s.billingUserId ?? s.ownerId,
      source: s.source ?? (s.unattended ? "invoke" : "web"),
      status: "active",
      createdAt: Date.now(),
    };
    this.sessions.set(s.id, session);
    return { ...session };
  }

  /**
   * 内存实现不知道运行(没有 runs 表),只按会话创建时间判定;
   * "有活动 / 在执行的运行挡住清理"由 MySQL 实现与其契约测试保证。
   */
  async markWorkspacePurged(
    id: string,
    opts: { cutoffMs: number; nowMs: number },
  ): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s || s.createdAt >= opts.cutoffMs) return false;
    s.workspacePurgedAt = opts.nowMs;
    return true;
  }

  async get(id: string): Promise<Session | null> {
    const s = this.sessions.get(id);
    return s ? { ...s } : null;
  }

  async list(filter?: SessionListFilter): Promise<Session[]> {
    return [...this.sessions.values()]
      .filter((s) => {
        if (filter?.ownerId !== undefined && s.ownerId !== filter.ownerId) return false;
        if (filter?.callerApiKeyId !== undefined && s.callerApiKeyId !== filter.callerApiKeyId) {
          return false;
        }
        if (filter?.billingUserId !== undefined && s.billingUserId !== filter.billingUserId) {
          return false;
        }
        if (filter?.sources && !filter.sources.includes(s.source)) return false;
        if (s.status === "deleted") return false;
        if (s.status === "archived" && !filter?.includeArchived) return false;
        return true;
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async setSdkSessionId(id: string, sdkSessionId: string): Promise<void> {
    const s = this.sessions.get(id);
    if (s) s.sdkSessionId = sdkSessionId;
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async update(
    id: string,
    patch: { title?: string; status?: SessionStatus; designTargetAgentId?: string },
  ): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    if (patch.designTargetAgentId !== undefined) s.designTargetAgentId = patch.designTargetAgentId;
    if (patch.title !== undefined) s.title = patch.title;
    if (patch.status !== undefined) s.status = patch.status;
  }
}
