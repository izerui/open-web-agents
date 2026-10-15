import { randomUUID } from "node:crypto";
import type { Db } from "@/lib/db/client";
import { MysqlAgentRepo } from "@/lib/modules/agent/adapters/mysql-agent-repo";
import type { AgentConfig } from "@/lib/modules/agent/domain/config";
import type { Agent } from "@/lib/modules/agent/ports";

export interface CloneInput {
  clonedId: string;
  ownerId: string;
  name: string;
  icon?: string;
  description?: string;
  config: AgentConfig;
  docs: { title: string; content: string }[];
}

export interface CloneResult {
  agent: Agent;
  knowledgeCopied: number;
}

export interface KnowledgeWriter {
  create(doc: { id: string; agentId: string; title: string; content: string }): Promise<unknown>;
}

export async function cloneAgentInTransaction(
  db: Db,
  input: CloneInput,
  knowledgeFactory: (tx: Db) => KnowledgeWriter,
): Promise<CloneResult> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const txAgents = new MysqlAgentRepo(txDb);
    const saved = await txAgents.upsert({
      id: input.clonedId,
      ownerId: input.ownerId,
      name: input.name,
      icon: input.icon,
      description: input.description,
      config: input.config,
    });

    let knowledgeCopied = 0;
    if (input.docs.length > 0) {
      const txKnowledge = knowledgeFactory(txDb);
      for (const doc of input.docs) {
        await txKnowledge.create({
          id: randomUUID().replace(/-/g, "").slice(0, 24),
          agentId: input.clonedId,
          title: doc.title,
          content: doc.content,
        });
        knowledgeCopied++;
      }
    }

    return { agent: saved, knowledgeCopied };
  });
}
