"use client";

// 构建页的数据:智能体列表(左栏与本智能体的完整配置)、页头徽标与上线清单要的元数据。

import type { StudioAgent } from "@/features/studio/studio-model";
import { AGENT_CATALOG_CHANGED } from "@/lib/agent-catalog";
import { errorText, fetchJson } from "@/lib/fetch-json";
import type { SnapshotChange } from "@/lib/modules/agent/domain/snapshot-diff";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EvalSummary } from "./build-model";

export type BuildAgent = StudioAgent & {
  config: Record<string, unknown>;
  webhookUrl?: string;
};

export function useAgentList() {
  const [agents, setAgents] = useState<BuildAgent[]>([]);
  const [stdio, setStdio] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const s = ++seq.current;
    try {
      const d = await fetchJson<{ agents?: BuildAgent[]; capabilities?: { stdioMcp?: boolean } }>(
        "/api/agents",
      );
      if (s !== seq.current) return;
      setAgents(d.agents ?? []);
      setStdio(d.capabilities?.stdioMcp === true);
      setError(null);
    } catch (e) {
      if (s === seq.current) setError(errorText(e));
    } finally {
      if (s === seq.current) setLoaded(true);
    }
  }, []);
  useEffect(() => {
    void reload();
    const on = () => void reload();
    window.addEventListener(AGENT_CATALOG_CHANGED, on);
    return () => window.removeEventListener(AGENT_CATALOG_CHANGED, on);
  }, [reload]);
  return { agents, stdio, loaded, error, reload };
}

export interface VersionMeta {
  version: number;
  name: string;
  note?: string;
  createdBy: string;
  createdAt: number;
}

export interface KeyRecord {
  id: string;
  name?: string;
  agentId?: string;
  rateLimitPerMinute?: number;
  monthlyLimitMicroCredits?: string;
  monthUsedMicroCredits?: string;
  expiresAt?: number;
  createdAt: number;
  lastUsedAt?: number;
}

export interface AgentMeta {
  versions: VersionMeta[] | null;
  evals: { draft: EvalSummary; versions: Record<string, EvalSummary> } | null;
  caseCount: number;
  keys: KeyRecord[];
  rateLimits: { perKeyPerMinute: number; perAgentPerMinute: number };
  knowledge: { count: number; titles: string[] };
  changeCount: number | null;
}

const EMPTY_META: AgentMeta = {
  versions: null,
  evals: null,
  caseCount: 0,
  keys: [],
  rateLimits: { perKeyPerMinute: 0, perAgentPerMinute: 0 },
  knowledge: { count: 0, titles: [] },
  changeCount: null,
};

/**
 * 页头徽标、上线清单、档案摘要要的几块数据,各拉各的:任一块失败只影响它自己。
 * canWrite = false(只读)时只读知识清单。
 */
export function useAgentMeta(
  agentId: string | null,
  opts: { canWrite: boolean; publishedVersion: number | null; hasUnpublishedChanges: boolean },
) {
  const [meta, setMeta] = useState<AgentMeta>(EMPTY_META);
  const seq = useRef(0);
  const { canWrite, publishedVersion, hasUnpublishedChanges } = opts;

  const loadVersions = useCallback(async () => {
    if (!agentId || !canWrite) return;
    const base = `/api/agents/${encodeURIComponent(agentId)}`;
    const [v, c] = await Promise.allSettled([
      fetchJson<{
        versions: VersionMeta[];
        evals?: { draft: EvalSummary; versions: Record<string, EvalSummary> };
      }>(`${base}/versions`),
      fetchJson<{ cases: unknown[] }>(`${base}/evals/cases`),
    ]);
    setMeta((m) => ({
      ...m,
      ...(v.status === "fulfilled"
        ? { versions: v.value.versions, evals: v.value.evals ?? null }
        : { versions: m.versions ?? [] }),
      ...(c.status === "fulfilled" ? { caseCount: c.value.cases.length } : {}),
    }));
  }, [agentId, canWrite]);

  const loadKeys = useCallback(async () => {
    if (!agentId || !canWrite) return;
    try {
      const k = await fetchJson<{
        keys?: KeyRecord[];
        rateLimits?: { perKeyPerMinute: number; perAgentPerMinute: number };
      }>("/api/keys");
      setMeta((m) => ({
        ...m,
        keys: (k.keys ?? []).filter((x) => x.agentId === agentId),
        rateLimits: k.rateLimits ?? m.rateLimits,
      }));
    } catch {
      // 徽标显示「未签 Key」即可;接入阶段自己会报错
    }
  }, [agentId, canWrite]);

  const loadKnowledge = useCallback(async () => {
    if (!agentId) return;
    try {
      const k = await fetchJson<{ docs?: { title: string }[] }>(
        `/api/agents/${encodeURIComponent(agentId)}/knowledge`,
      );
      const docs = k.docs ?? [];
      setMeta((m) => ({
        ...m,
        knowledge: { count: docs.length, titles: docs.map((d) => d.title) },
      }));
    } catch {
      // 摘要显示还没填
    }
  }, [agentId]);

  const loadChanges = useCallback(async () => {
    if (!agentId || !canWrite || publishedVersion === null || !hasUnpublishedChanges) {
      setMeta((m) => ({ ...m, changeCount: publishedVersion === null ? null : 0 }));
      return;
    }
    try {
      const d = await fetchJson<{ changes: SnapshotChange[] }>(
        `/api/agents/${encodeURIComponent(agentId)}/versions/diff?from=${publishedVersion}&to=draft`,
      );
      setMeta((m) => ({ ...m, changeCount: d.changes.length }));
    } catch {
      setMeta((m) => ({ ...m, changeCount: null }));
    }
  }, [agentId, canWrite, publishedVersion, hasUnpublishedChanges]);

  useEffect(() => {
    seq.current++;
    setMeta(EMPTY_META);
    void loadVersions();
    void loadKeys();
    void loadKnowledge();
  }, [loadVersions, loadKeys, loadKnowledge]);

  useEffect(() => {
    void loadChanges();
  }, [loadChanges]);

  // 草稿评测进行中:每 3 秒重读一次(服务端读的时候顺带判分)
  useEffect(() => {
    if (meta.evals?.draft.state !== "running") return;
    const t = setTimeout(() => void loadVersions(), 3000);
    return () => clearTimeout(t);
  }, [meta.evals, loadVersions]);

  return { meta, loadVersions, loadKeys, loadKnowledge, loadChanges };
}
