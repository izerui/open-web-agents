import { getContainer } from "@/lib/container";
import { designCaller, designError } from "../_lib/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Context) {
  try {
    const { subject } = await designCaller(req);
    return Response.json(await getContainer().designer.inspect(subject, (await params).id), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return designError(err);
  }
}

export async function PATCH(req: Request, { params }: Context) {
  try {
    const { subject } = await designCaller(req);
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body))
      return Response.json({ error: "invalid request" }, { status: 400 });
    return Response.json(await getContainer().designer.update(subject, (await params).id, body));
  } catch (err) {
    return designError(err);
  }
}
