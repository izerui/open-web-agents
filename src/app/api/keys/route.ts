import { randomUUID } from "node:crypto";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { hasResourceAccess } from "@/lib/modules/access/domain/grants";
import { generateApiKey, hashApiKey } from "@/lib/modules/identity/domain/api-key";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * key 的归属【必须是当前登录用户】。
 *
 * 这里曾经硬编码成 WEB_USER_ID(那是「关闭登录的本地开发主体」常量),后果是三连:
 * 签发时所有人的 key 都记在同一个假 owner 名下 → 列表按同一常量过滤等于查全表
 * → 任意注册用户能枚举全平台的 key 并逐个吊销,一键瘫痪所有对接方。
 * 更隐蔽的是 subjectOf 会把所有 key 解析成同一身份,授权判定跟着一起失真。
 *
 * 教训:「本地开发兜底常量」漏进生产路径,比没有兜底更危险 —— 它让越权看起来像正常代码。
 */
async function currentUserId(req: Request): Promise<string> {
  const { auth } = getContainer();
  const principal = await auth.resolveWeb(req);
  // 对外 key 不能自我枚举/提权
  auth.assertCanManageAssistants(principal);
  return (await auth.subjectOf(principal)).userId;
}

/** 列出本账户的 key(只回元信息,永不回明文)。 */
export async function GET(req: Request) {
  const { apiKeys } = getContainer();
  try {
    return Response.json({ keys: await apiKeys.list(await currentUserId(req)) });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

/**
 * 签发一个新 key。
 * 明文【只在本次响应里返回一次】—— 库里只有哈希,丢了只能重新签发。
 */
export async function POST(req: Request) {
  const { apiKeys, assistants, grants, auth } = getContainer();

  let ownerId: string;
  try {
    ownerId = await currentUserId(req);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const body = (await req.json().catch(() => ({}))) as { name?: string; assistantId?: string };

  // 绑定到具体助手时,不仅要确认它存在,还要确认签发人对它有权限 ——
  // 否则等于把「越权运行他人助手」从一次性利用固化成一把长期有效的专用凭证,
  // 而且那把 key 在受害者的界面上根本看不见。
  //
  // 存在与无权返回同一个 404:不区分二者,免得这个接口变成助手 id 的存在性预言机。
  if (body.assistantId) {
    const a = await assistants.get(body.assistantId);
    const subject = await auth.subjectOf(await auth.resolveWeb(req));
    const list = await grants.listForResource("assistant", body.assistantId);
    if (!a || !hasResourceAccess(subject, a, "read", list)) {
      return Response.json({ error: "assistant not found" }, { status: 404 });
    }
  }

  const plain = generateApiKey();
  const record = await apiKeys.create({
    id: randomUUID().replace(/-/g, "").slice(0, 24),
    ownerId,
    assistantId: body.assistantId,
    name: body.name,
    hashedKey: hashApiKey(plain),
  });

  return Response.json(
    {
      key: record,
      /** 仅此一次可见 */
      plaintext: plain,
      hint: "请立刻保存;服务端只存哈希,无法再次显示",
    },
    { status: 201 },
  );
}

/** 吊销 key —— 只能吊销自己的。 */
export async function DELETE(req: Request) {
  const { apiKeys } = getContainer();

  let ownerId: string;
  try {
    ownerId = await currentUserId(req);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });

  // 归属校验必须在 revoke 之前 —— 这里曾经拿到 id 就直接删
  const record = await apiKeys.get(id);
  if (!record || record.ownerId !== ownerId) {
    return Response.json({ error: "key not found" }, { status: 404 });
  }

  await apiKeys.revoke(id);
  return Response.json({ revoked: id });
}
