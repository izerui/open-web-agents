import type { NewSession, Session, SessionRepo } from "@/lib/modules/session/ports";

/** 内存会话仓储。垂直切片先用它跑通,MySQL adapter 后续替换(端口不变)。 */
export class InMemorySessionRepo implements SessionRepo {
  private sessions = new Map<string, Session>();

  async create(s: NewSession): Promise<Session> {
    const session: Session = { ...s, createdAt: Date.now() };
    this.sessions.set(s.id, session);
    return { ...session };
  }

  async get(id: string): Promise<Session | null> {
    const s = this.sessions.get(id);
    return s ? { ...s } : null;
  }

  async list(): Promise<Session[]> {
    return [...this.sessions.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  async setSdkSessionId(id: string, sdkSessionId: string): Promise<void> {
    const s = this.sessions.get(id);
    if (s) s.sdkSessionId = sdkSessionId;
  }
}
