// 登录用例:注册 / 登录 / 从 cookie 解析当前用户。
// 只依赖端口与纯域函数,便于用内存 fake 完整单测。

import { randomInt, randomUUID } from "node:crypto";
import { hashPassword, verifyPassword } from "@/lib/modules/identity/domain/password";
import {
  buildClearCookie,
  buildSessionCookie,
  issueToken,
  readSessionCookie,
  verifyToken,
} from "@/lib/modules/identity/domain/session-token";
import type { User, UserRepo } from "@/lib/modules/identity/user-ports";

/** 登录态有效期。 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface AuthServiceDeps {
  users: UserRepo;
  sessionSecret: string;
  /** 生产环境下 cookie 加 Secure。 */
  secureCookie: boolean;
  /**
   * 是否开放自助注册。关掉后只有第一个账号(平台管理员)能自助注册,其余账号由管理员创建。
   * 曾经注册完全开放:任何能访问到平台的人都能注册、签 key、花平台的钱。
   */
  allowSignup?: boolean;
}

function assertEmail(email: string): string {
  const v = email.trim().toLowerCase();
  // 只做基本形状校验:真正的可达性靠后续邮件验证(MVP 不做)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new AuthError("邮箱格式不正确");
  return v;
}

function assertPassword(pw: string): void {
  if (pw.length < 8) throw new AuthError("密码至少 8 位");
}

/** 一次性初始密码:16 位,去掉易混字符。 */
function generateTempPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  return Array.from({ length: 16 }, () => alphabet[randomInt(alphabet.length)]).join("");
}

export class AuthService {
  constructor(private readonly deps: AuthServiceDeps) {}

  /** 首个注册的用户自动成为 admin —— 自托管部署无需额外的初始化脚本。 */
  async register(email: string, password: string): Promise<{ user: User; cookie: string }> {
    const e = assertEmail(email);
    assertPassword(password);

    const isFirst = (await this.deps.users.count()) === 0;
    if (!isFirst && this.deps.allowSignup === false) {
      throw new AuthError("当前平台未开放注册,请联系管理员开通账号", 403);
    }
    if (await this.deps.users.findByEmail(e)) throw new AuthError("该邮箱已注册", 409);

    const user = await this.deps.users.create({
      id: randomUUID().replace(/-/g, "").slice(0, 24),
      email: e,
      passwordHash: await hashPassword(password),
      role: isFirst ? "admin" : "user",
    });
    return { user, cookie: this.cookieFor(user.id) };
  }

  /**
   * 管理员创建账号。不受"开放注册"开关限制 —— 关闭自助注册之后,这是开通账号的唯一途径。
   * 返回一次性的初始密码,由管理员转交;用户登录后应在「账号安全」里改掉。
   */
  async createAccount(
    email: string,
    role: "admin" | "user" = "user",
  ): Promise<{ user: User; tempPassword: string }> {
    const e = assertEmail(email);
    if (await this.deps.users.findByEmail(e)) throw new AuthError("该邮箱已注册", 409);
    const tempPassword = generateTempPassword();
    const user = await this.deps.users.create({
      id: randomUUID().replace(/-/g, "").slice(0, 24),
      email: e,
      passwordHash: await hashPassword(tempPassword),
      role,
    });
    return { user, tempPassword };
  }

  /** 管理员重置某账号的密码,返回一次性的新密码。 */
  async resetPassword(userId: string): Promise<string> {
    const tempPassword = generateTempPassword();
    await this.deps.users.setPasswordHash(userId, await hashPassword(tempPassword));
    return tempPassword;
  }

  /** 用户自己改密码:必须先证明知道当前密码。 */
  async changePassword(userId: string, current: string, next: string): Promise<void> {
    const record = await this.deps.users.getWithPassword(userId);
    if (!record || !(await verifyPassword(current, record.passwordHash))) {
      throw new AuthError("当前密码不正确", 400);
    }
    assertPassword(next);
    await this.deps.users.setPasswordHash(userId, await hashPassword(next));
  }

  /**
   * 登录。邮箱不存在与密码错误返回【同一个】错误 ——
   * 区分开会让攻击者能枚举出哪些邮箱已注册。
   */
  async login(email: string, password: string): Promise<{ user: User; cookie: string }> {
    const record = await this.deps.users.findByEmail(email);
    const ok = record ? await verifyPassword(password, record.passwordHash) : false;
    if (!record || !ok) throw new AuthError("邮箱或密码不正确", 401);

    /*
     * 【为什么密码验过了才查禁用】先查禁用会让这个接口变成账号存在性预言机:
     * 拿一个乱密码试,回"账号已停用"就说明这个邮箱注册过。
     * 顺序必须是"先证明你是账号主人,再告诉你账号状态"。
     */
    if (record.disabled) throw new AuthError("该账号已被停用,请联系平台管理员", 403);

    const { passwordHash: _drop, ...user } = record;
    return { user, cookie: this.cookieFor(user.id) };
  }

  /** 从请求 cookie 解析当前用户;无效/过期/已停用返回 null。 */
  async currentUser(req: Request): Promise<User | null> {
    const token = readSessionCookie(req.headers.get("cookie"));
    if (!token) return null;
    const payload = verifyToken(this.deps.sessionSecret, token);
    if (!payload) return null;
    // 令牌有效但用户已被删除 → 视为未登录
    const user = await this.deps.users.get(payload.userId);
    if (!user) return null;

    /*
     * 【为什么这里也要查,而不只在登录时查】会话令牌签发后有 7 天有效期,
     * 只在登录处拦截的话,一个正在使用中的账号被停用后,它手上那张
     * 仍然合法的 cookie 还能继续用整整一周 —— 停用等于没停。
     * 每个请求都要判,停用才是即时生效的。
     */
    if (user.disabled) return null;
    return user;
  }

  private cookieFor(userId: string): string {
    const token = issueToken(this.deps.sessionSecret, userId, SESSION_TTL_MS);
    return buildSessionCookie(token, SESSION_TTL_MS, this.deps.secureCookie);
  }

  logoutCookie(): string {
    return buildClearCookie(this.deps.secureCookie);
  }
}
