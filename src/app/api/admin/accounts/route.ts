import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { monthStartUtc } from "@/lib/modules/billing/application/run-charging";
import { parseCredits } from "@/lib/modules/capabilities/domain/catalog";
import { AuthError } from "@/lib/modules/identity/application/auth-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 平台账号列表。
 *
 * 【为什么把花费和智能体数一起算进来】这是运营看的页面,光有邮箱和注册时间
 * 判断不了任何事 —— 谁在真正使用、谁在烧钱,才是决定要不要调额度/停用的依据。
 */
export async function GET(req: Request) {
  const { users, agents, auth, billingMode, runCharges } = getContainer();
  try {
    const principal = await auth.resolveWeb(req);
    auth.assertCanAdministerPlatform(principal);

    const since = monthStartUtc(Date.now());
    // 本月用量按当前计费模式的口径(与受理时检查月度上限一致):试算看预计消耗,正式看实际扣除
    const mode = await billingMode.get();
    // 几个查询互不依赖,并行拿;各自都是一次性批量,没有 N+1
    // 智能体数量用聚合查询 —— 曾经数的是"全库最新 200 条",智能体一多就数错
    const [list, usedMap, agentCount] = await Promise.all([
      users.listAll(),
      runCharges.monthUsageByAccount(mode, since),
      agents.countByOwner(),
    ]);

    return Response.json({
      monthStart: since,
      billingMode: mode,
      accounts: list.map((u) => ({
        id: u.id,
        email: u.email,
        role: u.role,
        disabled: u.disabled,
        createdAt: u.createdAt,
        agentCount: agentCount.get(u.id) ?? 0,
        monthUsedMicroCredits: (usedMap.get(u.id) ?? 0n).toString(),
        monthlyLimitMicroCredits: u.monthlyLimitMicroCredits ?? null,
        // 升级遗留的美元上限:待管理员按积分设置(或明确设为不限)
        legacyLimitMicroUsd: u.legacyMonthlyLimitMicroUsd ?? null,
      })),
    });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

interface PatchBody {
  id?: string;
  role?: "admin" | "user";
  disabled?: boolean;
  /** 月度积分上限(积分文本,如 "500");null 表示取消限额。 */
  monthlyLimitCredits?: string | null;
  /** 重置密码:返回一次性新密码。 */
  resetPassword?: boolean;
}

/**
 * 管理员创建账号。关闭自助注册(OWA_ALLOW_SIGNUP=0)之后,这是开通账号的唯一途径。
 * 返回一次性初始密码 —— 只在这次响应里出现。
 */
export async function POST(req: Request) {
  const { auth, authService, audit } = getContainer();
  try {
    const principal = await auth.resolveWeb(req);
    auth.assertCanAdministerPlatform(principal);
    const body = (await req.json().catch(() => ({}))) as { email?: string; role?: string };
    if (!body.email) return Response.json({ error: "email is required" }, { status: 400 });
    if (body.role !== undefined && body.role !== "admin" && body.role !== "user") {
      return Response.json({ error: "role 须为 admin 或 user" }, { status: 400 });
    }
    const { user, tempPassword } = await authService.createAccount(body.email, body.role ?? "user");
    // 初始密码绝不进审计
    await audit.record({
      actor: principal,
      action: "account.create",
      resource: { type: "account", id: user.id },
      ownerId: user.id,
      details: { email: user.email, role: user.role },
      req,
    });
    return Response.json(
      { account: { id: user.id, email: user.email, role: user.role }, tempPassword },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof AuthError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

/** 改一个账号的角色 / 停用状态 / 月度积分上限。 */
export async function PATCH(req: Request) {
  const { users, auth, authService, audit } = getContainer();
  try {
    const principal = await auth.resolveWeb(req);
    auth.assertCanAdministerPlatform(principal);

    const body = (await req.json().catch(() => ({}))) as PatchBody;
    if (!body.id) return Response.json({ error: "id is required" }, { status: 400 });
    // 曾经 role 不校验取值,传什么存什么
    if (body.role !== undefined && body.role !== "admin" && body.role !== "user") {
      return Response.json({ error: "role 须为 admin 或 user" }, { status: 400 });
    }

    const target = await users.get(body.id);
    if (!target) return Response.json({ error: "account not found" }, { status: 404 });

    const selfId = principal.type === "web" ? principal.userId : "";

    /*
     * 【为什么不许改自己】管理员把自己降级或停用,是这套系统里最容易造成
     * 不可恢复状态的操作 —— 尤其在只有一个管理员时,做完就再也进不来了。
     * 要改自己,得让另一个管理员来改,这样至少保证操作时有人在场。
     */
    if (target.id === selfId && (body.role !== undefined || body.disabled !== undefined)) {
      return Response.json(
        { error: "不能改自己的角色或停用自己,请让另一位管理员操作" },
        { status: 400 },
      );
    }

    /*
     * 【为什么要数管理员】上面只挡住了"改自己"。但两个管理员互相降级,
     * 一样能把平台降到零管理员 —— 那之后没有任何界面能恢复,只能连数据库。
     * 所以在真正落库前再数一次。
     */
    const losingAdmin = target.role === "admin" && (body.role === "user" || body.disabled === true);
    if (losingAdmin && (await users.countAdmins()) <= 1) {
      return Response.json(
        { error: "这是最后一位管理员,降级或停用后将没有人能进入平台管理" },
        { status: 400 },
      );
    }

    let monthlyLimitMicroCredits: string | null | undefined;
    if (body.monthlyLimitCredits === null) monthlyLimitMicroCredits = null;
    else if (body.monthlyLimitCredits !== undefined) {
      try {
        if (typeof body.monthlyLimitCredits !== "string") throw new Error();
        monthlyLimitMicroCredits = parseCredits(body.monthlyLimitCredits.trim());
      } catch {
        return Response.json(
          { error: "月度上限须为非负积分数(最多六位小数),或 null 表示不限" },
          { status: 400 },
        );
      }
    }

    await users.adminUpdate(body.id, {
      role: body.role,
      disabled: body.disabled,
      monthlyLimitMicroCredits,
    });
    const tempPassword = body.resetPassword ? await authService.resetPassword(body.id) : undefined;

    const updated = await users.get(body.id);

    // 记在被改的账号名下:当事人也看得到管理员对自己做了什么
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (body.role !== undefined && body.role !== target.role) {
      changes.role = { from: target.role, to: body.role };
    }
    if (body.disabled !== undefined && body.disabled !== target.disabled) {
      changes.disabled = { from: target.disabled, to: body.disabled };
    }
    if (
      monthlyLimitMicroCredits !== undefined &&
      monthlyLimitMicroCredits !== (target.monthlyLimitMicroCredits ?? null)
    ) {
      changes.monthlyLimitMicroCredits = {
        from: target.monthlyLimitMicroCredits ?? null,
        to: monthlyLimitMicroCredits,
      };
    }
    if (monthlyLimitMicroCredits !== undefined && target.legacyMonthlyLimitMicroUsd !== undefined) {
      changes.legacyMonthlyLimitMicroUsd = { from: target.legacyMonthlyLimitMicroUsd, to: null };
    }
    if (Object.keys(changes).length > 0) {
      await audit.record({
        actor: principal,
        action: "account.update",
        resource: { type: "account", id: target.id },
        ownerId: target.id,
        details: { email: target.email, changes },
        req,
      });
    }
    if (tempPassword) {
      // 只记"重置过",新密码绝不进审计
      await audit.record({
        actor: principal,
        action: "account.reset_password",
        resource: { type: "account", id: target.id },
        ownerId: target.id,
        details: { email: target.email },
        req,
      });
    }

    return Response.json({
      account: updated && {
        id: updated.id,
        email: updated.email,
        role: updated.role,
        disabled: updated.disabled,
        monthlyLimitMicroCredits: updated.monthlyLimitMicroCredits ?? null,
      },
      ...(tempPassword ? { tempPassword } : {}),
    });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
