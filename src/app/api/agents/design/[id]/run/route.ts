import { randomUUID } from "node:crypto";
import { admissionErrorResponse, callerOf } from "@/app/api/_lib/admission";
import { streamRun } from "@/app/api/_lib/run-stream";
import { chargeErrorResponse } from "@/lib/api-error";
import { getContainer } from "@/lib/container";
import { designCaller, designError } from "../../_lib/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { principal, subject } = await designCaller(req);
    const { id } = await params;
    const { auth, designer, admission, bus, runs } = getContainer();
    await auth.assertSessionAccess(principal, id);
    const body = (await req.json().catch(() => ({}))) as { prompt?: unknown; revision?: string };
    const admitted = await admission.admit({
      sessionId: id,
      caller: callerOf(principal),
      prompt: body.prompt,
    });
    const runId = randomUUID().replace(/-/g, "").slice(0, 24);
    await designer.enqueue(subject, id, runId, admitted.prompt, body.revision);
    // 从 0-0 补读 Stream,包括订阅之前产生的事件。
    return streamRun(req, {
      bus,
      results: runs,
      sessionId: id,
      runId,
      enqueue: async () => {},
    });
  } catch (err) {
    return admissionErrorResponse(err) ?? chargeErrorResponse(err) ?? designError(err);
  }
}
