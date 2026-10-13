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

  /** 每个会话一条 Promise 链,模拟 MySQL 的行锁(同一会话的协议操作串行)。 */
  private locks = new Map<string, Promise<unknown>>();

  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(
      id,
      next.catch(() => {}),
    );
    return next;
  }

  async withWorkspaceLock<T>(
    id: string,
    fn: (state: { workspacePurgedAt?: number } | null) => Promise<T>,
  ): Promise<T> {
    return this.withLock(id, async () => {
      const s = this.sessions.get(id);
      return fn(s ? { workspacePurgedAt: s.workspacePurgedAt } : null);
    });
  }

  async prepareWorkspace(
    id: string,
    opts: { nowMs: number },
    ensure: () => Promise<void>,
  ): Promise<void> {
    await this.withLock(id, async () => {
      const s = this.sessions.get(id);
      if (s) s.workspaceTouchedAt = opts.nowMs;
      await ensure();
    });
  }

  /**
   * 内存实现没有 runs 表,只判定会话创建时间与最近使用时刻;
   * "有活动 / 在执行的运行挡住清理"由 MySQL 实现与其测试保证。
   */
  async reclaimWorkspace(
    id: string,
    opts: { quietSinceMs: number; nowMs: number; kind: "purge" | "clean" },
    op: () => Promise<void>,
  ): Promise<boolean> {
    return this.withLock(id, async () => {
      const s = this.sessions.get(id);
      if (!s || s.createdAt >= opts.quietSinceMs) return false;
      if (s.workspaceTouchedAt !== undefined && s.workspaceTouchedAt >= opts.quietSinceMs) {
        return false;
      }
      const prev = s.workspacePurgedAt;
      if (opts.kind === "purge") s.workspacePurgedAt = opts.nowMs;
      try {
        await op();
      } catch (err) {
        s.workspacePurgedAt = prev; // 与事务回滚一致:只回滚标记,不管文件
        throw err;
      }
      return true;
    });
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
