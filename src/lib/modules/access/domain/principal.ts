// 调用主体与归属判定。纯逻辑,零 IO —— 授权规则必须能被穷举单测。

import {
  type Grant,
  type OwnedResource,
  type Subject,
  hasResourceAccess,
} from "@/lib/modules/access/domain/grants";

/** 谁在调用。web = 平台内人类(当前单用户);apiKey = 第三方系统。 */
export type Principal =
  | { type: "web"; userId: string; role?: "admin" | "user" }
  | { type: "apiKey"; keyId: string; ownerId: string; agentId?: string };

/** 资源的归属信息(从库里读出后传入)。 */
export interface SessionOwnership {
  id: string;
  agentId: string;
  ownerId?: string;
  callerApiKeyId?: string;
}

export type Decision = { allowed: true } | { allowed: false; reason: string };

const ALLOW: Decision = { allowed: true };
const deny = (reason: string): Decision => ({ allowed: false, reason });

/**
 * 能否访问某会话(读事件流、看工作空间文件、取结果)。
 *
 * 这是 question-bank 的已知短板:那边任何人拿到 sessionId 就能读别人的工作空间。
 * 这里的规则:
 * - web 用户:只能访问自己创建的会话
 * - API Key:只能访问【由它自己发起】的会话 —— 光有同一智能体的 key 还不够,
 *   否则同一智能体的两个调用方能互相读到对方的输入与产物
 */
export function canAccessSession(p: Principal, s: SessionOwnership): Decision {
  if (p.type === "web") {
    if (!s.ownerId) {
      // 无归属的历史数据(单用户时期创建)。开了登录之后若一律放行,任何新用户都能
      // 读到这些会话 —— 故只对 admin 开放:既不丢旧数据,也不构成跨用户泄露。
      return p.role === "admin" ? ALLOW : deny("session has no owner");
    }
    return s.ownerId === p.userId ? ALLOW : deny("session belongs to another user");
  }

  if (!s.callerApiKeyId) return deny("session was not created by an API key");
  return s.callerApiKeyId === p.keyId ? ALLOW : deny("session belongs to another caller");
}

/**
 * 能否调用某智能体。两道关卡缺一不可:
 *
 * 1. **key 绑定**:key 若绑定了具体智能体,就只能调那一个 —— 便于给每个对接方发限定 key。
 * 2. **资源授权**:调用方必须对该智能体有 read 权限(owner / admin / 被分享)。
 *
 * 第 2 关曾经缺失,是个真实越权:当时 web 主体一律放行、未绑定的 key 也一律放行,
 * 于是【知道 agentId 就能运行别人的私有智能体】—— 撤销分享只是从列表里隐藏,
 * 不阻止使用,而智能体的 systemPrompt 与知识库正文会直接进入攻击者的会话。
 *
 * 教训:「有一套授权体系」不等于「每条路径都接了它」。分享读写路径当时都接了,
 * 唯独最要紧的运行路径没接 —— 而那才是资产真正泄漏的地方。
 */
export function canInvokeAgent(
  p: Principal,
  agent: OwnedResource,
  subject: Subject,
  grants: Grant[],
): Decision {
  if (p.type === "apiKey" && p.agentId && p.agentId !== agent.id) {
    return deny("api key is bound to another agent");
  }
  // key 以其归属用户的身份参与判定 —— 不能靠签发 key 给自己提权
  if (!hasResourceAccess(subject, agent, "read", grants)) {
    return deny("no access to this agent");
  }
  return ALLOW;
}

/** 能否管理智能体定义(创建/修改)。对外 key 一律不行,防止调用方改提示词。 */
export function canManageAgents(p: Principal): Decision {
  return p.type === "web" ? ALLOW : deny("api keys cannot manage agents");
}

/**
 * 能否做平台管理动作(改别人的账号)。
 *
 * 【为什么对外 key 一律不行,哪怕它归管理员所有】key 是发给第三方系统的凭据,
 * 会躺在别人的服务器配置里。它的用途是调用智能体,不该顺带继承签发人的平台管理权 ——
 * 否则一把泄漏的 key 就能停掉全平台的账号。
 */
export function canAdministerPlatform(p: Principal): Decision {
  if (p.type !== "web") return deny("api keys cannot administer the platform");
  return p.role === "admin" ? ALLOW : deny("admin only");
}
