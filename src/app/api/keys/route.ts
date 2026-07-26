import { randomUUID } from "node:crypto";
import { getContainer } from "@/lib/container";
import { WEB_USER_ID, authErrorResponse } from "@/lib/modules/access/application/authorize";
import { generateApiKey, hashApiKey } from "@/lib/modules/identity/domain/api-key";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 列出本账户的 key(只回元信息,永不回明文)。 */
export async function GET(req: Request) {
  const { apiKeys, auth } = getContainer();
  try {
    const principal = await auth.resolveWeb(req);
    // 对外 key 不能自我枚举/提权
    auth.assertCanManageAssistants(principal);
    return Response.json({ keys: await apiKeys.list(WEB_USER_ID) });
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
  const { apiKeys, assistants, auth } = getContainer();

  try {
    auth.assertCanManageAssistants(await auth.resolveWeb(req));
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const body = (await req.json().catch(() => ({}))) as { name?: string; assistantId?: string };

  // 绑定到具体助手时先确认它存在,避免签出一把打不开任何门的钥匙
  if (body.assistantId && !(await assistants.get(body.assistantId))) {
    return Response.json({ error: "assistant not found" }, { status: 404 });
  }

  const plain = generateApiKey();
  const record = await apiKeys.create({
    id: randomUUID().replace(/-/g, "").slice(0, 24),
    ownerId: WEB_USER_ID,
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

/** 吊销 key。 */
export async function DELETE(req: Request) {
  const { apiKeys, auth } = getContainer();
  try {
    auth.assertCanManageAssistants(await auth.resolveWeb(req));
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  await apiKeys.revoke(id);
  return Response.json({ revoked: id });
}
