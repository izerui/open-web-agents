// 一次运行的回调投到哪、用谁的密钥签名。
//
// - 只推系统发起的运行(接口调用、API 会话)。曾经对每个运行都推 —— 被分享者在工作台里的对话、
//   访客在嵌入组件里的对话,最终回答都会被推到智能体所有者的地址上。
// - 目标按【受理时的快照】:之后改智能体的回调地址,已受理的任务(含自动重试、手动重发)仍投原地址。
//   签名账号按地址来源选:
//     agent  —— 智能体的默认地址:所有者签名(与智能体回调的约定一致,所有者的接收端按自己的密钥验签)
//     caller —— 调用方在 invoke 时指定的地址:调用方(签发这把 Key 的账号)签名。
//               接收方是调用方自己;所有者的密钥不替别人的地址签名
//     none   —— 受理时没有回调:不投
// - 快照功能之前受理的旧任务没有快照:按投递时智能体的配置投。

import type { WebhookJob } from "@/lib/modules/integration/ports";
import type { WebhookTarget } from "./webhook-dispatcher";

export interface RunTargetDeps {
  session(id: string): Promise<{ agentId: string; source: string; billingUserId?: string } | null>;
  /** 智能体当前配置的回调目标(地址 + 所有者密钥);没配返回 null。只用于没有快照的旧任务。 */
  agentTarget(agentId: string): Promise<WebhookTarget | null>;
  /** 智能体所有者的签名密钥;没配置返回 undefined,配置了却解不开必须抛错。 */
  ownerSecret(agentId: string): Promise<string | undefined>;
  /** 该账号的签名密钥;没配置返回 undefined,配置了却解不开必须抛错。 */
  userSecret(userId: string): Promise<string | undefined>;
}

export async function resolveRunTarget(
  deps: RunTargetDeps,
  job: Pick<WebhookJob, "sessionId" | "callback">,
): Promise<WebhookTarget | null> {
  const session = await deps.session(job.sessionId);
  if (!session || (session.source !== "invoke" && session.source !== "api")) return null;
  const snap = job.callback;
  if (!snap) return deps.agentTarget(session.agentId);
  if (snap.source === "none") return null;
  const secret =
    snap.source === "agent"
      ? await deps.ownerSecret(session.agentId)
      : session.billingUserId
        ? await deps.userSecret(session.billingUserId)
        : undefined;
  return { agentId: session.agentId, url: snap.url, ...(secret ? { secret } : {}) };
}
