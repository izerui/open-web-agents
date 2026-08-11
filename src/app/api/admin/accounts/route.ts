import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 本月起点(UTC)。花费统计和额度都按自然月算。 */
function monthStart(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

/**
 * 平台账号列表。
 *
 * 【为什么把花费和助手数一起算进来】这是运营看的页面,光有邮箱和注册时间
 * 判断不了任何事 —— 谁在真正使用、谁在烧钱,才是决定要不要调额度/停用的依据。
 */
export async function GET(req: Request) {
  const { users, usage, assistants, auth } = getContainer();
  try {
    const principal = await auth.resolveWeb(req);
    auth.assertCanAdministerPlatform(principal);

    const since = monthStart();
    // 三个查询互不依赖,并行拿;各自都是一次性批量,没有 N+1
    const [list, costMap, allAssistants] = await Promise.all([
      users.listAll(),
      usage.costByOwner(since),
      assistants.list(),
    ]);

    const assistantCount = new Map<string, number>();
    for (const a of allAssistants) {
      assistantCount.set(a.ownerId, (assistantCount.get(a.ownerId) ?? 0) + 1);
    }

    return Response.json({
      monthStart: since,
      accounts: list.map((u) => ({
        id: u.id,
        email: u.email,
        role: u.role,
        disabled: u.disabled,
        createdAt: u.createdAt,
        assistantCount: assistantCount.get(u.id) ?? 0,
        monthCostMicroUsd: costMap.get(u.id) ?? 0,
        monthlyQuotaMicroUsd: u.monthlyQuotaMicroUsd ?? null,
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
  /** 微美元;null 表示取消限额。 */
  monthlyQuotaMicroUsd?: number | null;
}

/** 改一个账号的角色 / 停用状态 / 月度额度。 */
export async function PATCH(req: Request) {
  const { users, auth } = getContainer();
  try {
    const principal = await auth.resolveWeb(req);
    auth.assertCanAdministerPlatform(principal);

    const body = (await req.json().catch(() => ({}))) as PatchBody;
    if (!body.id) return Response.json({ error: "id is required" }, { status: 400 });

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

    if (body.monthlyQuotaMicroUsd !== undefined && body.monthlyQuotaMicroUsd !== null) {
      if (!Number.isFinite(body.monthlyQuotaMicroUsd) || body.monthlyQuotaMicroUsd < 0) {
        return Response.json({ error: "额度必须是非负数" }, { status: 400 });
      }
    }

    await users.adminUpdate(body.id, {
      role: body.role,
      disabled: body.disabled,
      monthlyQuotaMicroUsd: body.monthlyQuotaMicroUsd,
    });

    const updated = await users.get(body.id);
    return Response.json({
      account: updated && {
        id: updated.id,
        email: updated.email,
        role: updated.role,
        disabled: updated.disabled,
        monthlyQuotaMicroUsd: updated.monthlyQuotaMicroUsd ?? null,
      },
    });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
