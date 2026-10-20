import type { Db } from "@/lib/db/client";
import { sql } from "drizzle-orm";
import type { AgentModelRefsQuery } from "../ports";

type Row = {
  id: string;
  draftModel: unknown;
  draftSubs: unknown;
  pubModel: unknown;
  pubSubs: unknown;
};

/** JSON_EXTRACT 的结果在驱动里可能是已解析值,也可能是 JSON 文本 */
function values(raw: unknown): string[] {
  if (raw === null || raw === undefined) return [];
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [v as string];
    }
  }
  const list = Array.isArray(v) ? v : [v];
  return list.filter((x): x is string => typeof x === "string" && x.length > 0);
}

export class MysqlAgentModelRefs implements AgentModelRefsQuery {
  constructor(private readonly db: Db) {}

  async list(): Promise<{ agentId: string; refs: string[] }[]> {
    // 配置里可能带很大的技能包,只取模型字段
    const [rows] = (await this.db.execute(sql`
      SELECT a.id AS id,
             JSON_EXTRACT(a.config, '$.model') AS draftModel,
             JSON_EXTRACT(a.config, '$.subagents[*].model') AS draftSubs,
             JSON_EXTRACT(v.config, '$.model') AS pubModel,
             JSON_EXTRACT(v.config, '$.subagents[*].model') AS pubSubs
        FROM agents a
        LEFT JOIN agent_versions v ON v.agent_id = a.id AND v.version = a.published_version
       WHERE a.deleted_at IS NULL
    `)) as unknown as [Row[]];
    return rows.map((r) => ({
      agentId: r.id,
      refs: [
        ...new Set([
          ...values(r.draftModel),
          ...values(r.draftSubs),
          ...values(r.pubModel),
          ...values(r.pubSubs),
        ]),
      ],
    }));
  }
}
