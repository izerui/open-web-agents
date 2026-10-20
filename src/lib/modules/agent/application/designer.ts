import { randomUUID } from "node:crypto";
import { type Subject, hasResourceAccess } from "@/lib/modules/access/domain/grants";
import type { GrantRepo } from "@/lib/modules/access/ports";
import type { StoragePort } from "@/lib/modules/artifacts/ports";
import type { EnqueueRequest } from "@/lib/modules/run/application/enqueue";
import type { RunRepo } from "@/lib/modules/run/ports";
import type { Session, SessionRepo } from "@/lib/modules/session/ports";
import { BrandedError } from "@/lib/shared";
import { ARCHITECT_CONFIG } from "../domain/architect";
import { restoreMcpSecrets } from "../domain/config";
import {
  DRAFT_FILE,
  type DesignState,
  designHash,
  designResources,
  designSnapshot,
  draftOf,
  mcpBaselineOf,
  parseDesign,
  resolveDesign,
} from "../domain/design";
import { contentHash, snapshotOf } from "../domain/release";
import { diffSnapshots } from "../domain/snapshot-diff";
import { DESIGN_EXECUTOR_ID, isSystemAgent } from "../domain/system-agent";
import { type ModelCatalogView, validateAgentConfig } from "../domain/validate-config";
import type { Agent, AgentRepo, AgentSnapshot } from "../ports";

export class DesignError extends BrandedError {
  static readonly brand = Symbol.for("owa.error.DesignError");

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface DesignTx {
  agents: AgentRepo;
  sessions: SessionRepo;
  grants: GrantRepo;
  runs: Pick<RunRepo, "get">;

  busy(): Promise<boolean>;

  enqueue(request: EnqueueRequest): Promise<unknown>;
}

export interface DesignerDeps {
  /** 与 GC 共用会话行锁;设计写入、保存与入队都在这个事务中串行。 */
  inSession<T>(id: string, fn: (tx: DesignTx) => Promise<T>): Promise<T>;

  storage: StoragePort;
  allowStdioMcp: boolean;
  /** 模型目录视图:检查草稿里的模型是否存在、可用、子代理与主模型同一来源 */
  modelCatalogView?: () => Promise<ModelCatalogView>;
}

export class AgentDesigner {
  constructor(private readonly deps: DesignerDeps) {}

  private async target(tx: DesignTx, subject: Subject, id: string): Promise<Agent> {
    const agent = await tx.agents.get(id);
    if (
      !agent ||
      isSystemAgent(id) ||
      !hasResourceAccess(subject, agent, "write", await tx.grants.listForResource("agent", id))
    ) {
      throw new DesignError(403, "forbidden", "目标智能体或资源来源不存在,或已无编辑权限");
    }
    return agent;
  }

  private async context(tx: DesignTx, subject: Subject, id: string) {
    const session = await tx.sessions.get(id);
    if (
      !session ||
      session.source !== "design" ||
      session.status === "deleted" ||
      session.ownerId !== subject.userId ||
      session.agentId !== DESIGN_EXECUTOR_ID
    ) {
      throw new DesignError(404, "not_found", "设计会话不存在");
    }
    const target = session.designTargetAgentId
      ? await this.target(tx, subject, session.designTargetAgentId)
      : undefined;
    return { session, target };
  }

  private async idle(tx: DesignTx) {
    if (await tx.busy())
      throw new DesignError(409, "design_busy", "AI 正在编辑,请等待完成或停止后再修改");
  }

  private async sync(tx: DesignTx, session: Session): Promise<DesignState | undefined> {
    const state = session.designState;
    if (!state || !state.aiRunId || state.aiRunId === state.importedRunId) return state;
    const run = await tx.runs.get(state.aiRunId);
    if (run && (run.state === "pending" || run.state === "running")) return state;
    const next: DesignState = { ...state, importedRunId: state.aiRunId, aiIssue: undefined };
    try {
      const file = await this.deps.storage.read(session.workspaceDir, DRAFT_FILE);
      next.draft = parseDesign(JSON.parse(file.bytes.toString("utf8")));
    } catch (err) {
      const reason = err instanceof Error ? err.message : "未知错误";
      next.aiIssue = `AI 输出不是有效的设计草稿:${reason}。已保留上一次草稿,可以继续对话修正。`;
    }
    await tx.sessions.update(session.id, { designState: next });
    session.designState = next;
    return next;
  }

  private async preview(tx: DesignTx, subject: Subject, session: Session, target?: Agent) {
    const state = await this.sync(tx, session);
    if (!state)
      return {
        sessionId: session.id,
        targetId: target?.id,
        targetName: target?.name,
        legacy: true as const,
        busy: await tx.busy(),
      };
    const resources: Agent[] = [];
    const issues: { field: string; message: string }[] = [];
    for (const id of state.resourceAgentIds) {
      try {
        resources.push(await this.target(tx, subject, id));
      } catch (err) {
        if (!(err instanceof DesignError)) throw err;
        issues.push({ field: "resources", message: "有资源来源已删除或撤销权限,请移除后重新选择" });
      }
    }
    let candidate: AgentSnapshot | undefined;
    try {
      const resolved = resolveDesign(state.draft, resources);
      const restoredConfig = restoreMcpSecrets(resolved.config, target?.config, state.mcpBaseline);
      candidate = { ...resolved, icon: target?.icon, config: restoredConfig };
      const models = await this.deps.modelCatalogView?.();
      issues.push(
        ...validateAgentConfig(candidate.config, {
          allowStdioMcp: this.deps.allowStdioMcp,
          models,
        }),
      );
    } catch (err) {
      issues.push({ field: "draft", message: err instanceof Error ? err.message : "草稿无法解析" });
    }
    const conflict = state.baseHash !== (target ? contentHash(snapshotOf(target)) : null);
    const before = target
      ? snapshotOf(target)
      : { name: "", config: { systemPrompt: "", model: "sonnet" as const } };
    return {
      sessionId: session.id,
      targetId: target?.id,
      targetName: target?.name,
      legacy: false as const,
      busy: await tx.busy(),
      draft: state.draft,
      resourceAgentIds: state.resourceAgentIds,
      resources: designResources(resources),
      revision: designHash(state),
      conflict,
      issues,
      aiIssue: state.aiIssue,
      changes: candidate ? diffSnapshots(designSnapshot(before), designSnapshot(candidate)) : [],
      // 绑定用户实际预览的配置(含服务端解析的资源),资源改变后也必须重新预览。
      previewToken: designHash({
        state,
        candidate,
        current: target ? contentHash(snapshotOf(target)) : null,
      }),
    };
  }

  inspect(subject: Subject, id: string) {
    return this.deps.inSession(id, async (tx) => {
      const { session, target } = await this.context(tx, subject, id);
      return this.preview(tx, subject, session, target);
    });
  }

  update(
    subject: Subject,
    id: string,
    input: {
      revision?: string;
      draft?: unknown;
      resourceAgentIds?: unknown;
      reset?: boolean;
    },
  ) {
    return this.deps.inSession(id, async (tx) => {
      const { session, target } = await this.context(tx, subject, id);
      await this.idle(tx);
      const state = await this.sync(tx, session);
      if (state && input.revision !== designHash(state)) {
        throw new DesignError(409, "design_changed", "设计草稿已变化,请刷新后重试");
      }
      let next: DesignState;
      if (input.reset) {
        next = {
          baseHash: target ? contentHash(snapshotOf(target)) : null,
          resourceAgentIds: target ? [target.id] : [],
          draft: draftOf(target),
          mcpBaseline: mcpBaselineOf(target),
        };
      } else {
        if (!state) throw new DesignError(409, "design_legacy", "旧设计须先载入当前草稿");
        next = { ...state, aiIssue: undefined };
        if (input.draft !== undefined) {
          try {
            next.draft = parseDesign(input.draft);
          } catch (err) {
            throw new DesignError(400, "invalid_request", (err as Error).message);
          }
        }
        if (input.resourceAgentIds !== undefined) {
          const ids = input.resourceAgentIds;
          if (!Array.isArray(ids) || ids.length > 20 || ids.some((v) => typeof v !== "string")) {
            throw new DesignError(400, "invalid_request", "资源来源须是最多 20 个智能体 ID");
          }
          for (const sourceId of ids) await this.target(tx, subject, sourceId);
          next.resourceAgentIds = [...new Set(ids)];
        }
      }
      await tx.sessions.update(id, { designState: next });
      session.designState = next;
      return this.preview(tx, subject, session, target);
    });
  }

  apply(subject: Subject, id: string, token?: string) {
    return this.deps.inSession(id, async (tx) => {
      const first = await this.context(tx, subject, id);
      await this.idle(tx);
      // 同一事务锁住目标行,与普通构建器保存、版本载入及其它设计会话的应用串行。
      if (first.session.designTargetAgentId)
        await tx.agents.lockRow(first.session.designTargetAgentId);
      const { session, target } = await this.context(tx, subject, id);
      const view = await this.preview(tx, subject, session, target);
      if (view.legacy) throw new DesignError(409, "design_legacy", "旧设计须先载入当前草稿");
      if (view.conflict)
        throw new DesignError(409, "target_changed", "目标智能体已被修改,请载入当前草稿后重新设计");
      if (!token || token !== view.previewToken)
        throw new DesignError(409, "preview_changed", "请先查看最新差异再保存");
      if (view.issues.length)
        throw new DesignError(
          400,
          "invalid_config",
          view.issues.map((i) => `${i.field}: ${i.message}`).join("; "),
        );
      const state = session.designState;
      if (!state) throw new DesignError(409, "design_legacy", "请先载入当前草稿");
      const resources = await Promise.all(
        state.resourceAgentIds.map((sourceId) => this.target(tx, subject, sourceId)),
      );
      const resolved = resolveDesign(state.draft, resources);
      const restoredConfig = restoreMcpSecrets(resolved.config, target?.config, state.mcpBaseline);
      const candidate = { ...resolved, icon: target?.icon, config: restoredConfig };
      // 资源在预览到应用之间改变时不能静默使用另一个版本。
      if (
        designHash({
          state,
          candidate,
          current: target ? contentHash(snapshotOf(target)) : null,
        }) !== token
      ) {
        throw new DesignError(409, "preview_changed", "资源配置已变化,请重新查看差异");
      }
      const agent = await tx.agents.upsert({
        ...target,
        ...candidate,
        id: target?.id ?? randomUUID().replace(/-/g, "").slice(0, 24),
        ownerId: target?.ownerId ?? subject.userId,
        icon: target?.icon,
        config: {
          ...candidate.config,
          escapeHatch: target?.config.escapeHatch,
        },
      });
      await tx.sessions.update(id, {
        designTargetAgentId: agent.id,
        title: `设计:${agent.name}`,
        designState: {
          ...state,
          baseHash: contentHash(snapshotOf(agent)),
          draft: draftOf(agent),
          mcpBaseline: mcpBaselineOf(agent),
        },
      });
      return {
        agent: { id: agent.id, name: agent.name },
        created: !target,
        before: target,
        saved: agent,
      };
    });
  }

  enqueue(subject: Subject, id: string, runId: string, prompt: string, revision?: string) {
    return this.deps.inSession(id, async (tx) => {
      const { session } = await this.context(tx, subject, id);
      await this.idle(tx);
      const state = await this.sync(tx, session);
      if (!state) throw new DesignError(409, "design_legacy", "请先载入当前草稿");
      if (revision !== designHash(state))
        throw new DesignError(409, "design_changed", "设计草稿已变化,请刷新后再发送");
      const resources = await Promise.all(
        state.resourceAgentIds.map((sourceId) => this.target(tx, subject, sourceId)),
      );
      // 单个文件是 AI 的工作副本;数据库草稿在运行结束后才导入。写文件失败不会改掉数据库草稿。
      await this.deps.storage.write(
        session.workspaceDir,
        DRAFT_FILE,
        Buffer.from(JSON.stringify(state.draft, null, 2)),
        { overwrite: true },
      );
      await tx.enqueue({
        runId,
        sessionId: id,
        prompt,
        noCallback: true,
        release: {
          version: null,
          config: {
            ...ARCHITECT_CONFIG,
            systemPrompt: `${ARCHITECT_CONFIG.systemPrompt}\n\n可引用资源(只认 ref):\n${JSON.stringify(designResources(resources))}`,
          },
        },
      });
      await tx.sessions.update(id, {
        designState: { ...state, aiRunId: runId, aiIssue: undefined },
      });
    });
  }
}
