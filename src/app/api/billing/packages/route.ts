import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import type { PackageDefinition } from "@/lib/modules/billing/package-ports";
import { BillingError } from "@/lib/modules/billing/ports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const { auth, packages } = getContainer();
    const principal = await auth.resolveWeb(req);
    const manage = new URL(req.url).searchParams.get("manage") === "1";
    if (manage) auth.assertCanAdministerPlatform(principal);
    return Response.json(
      { packages: await packages.list(manage), paymentMode: "manual", permanentCredits: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const response = authErrorResponse(err);
    if (response) return response;
    throw err;
  }
}

export async function POST(req: Request) {
  try {
    const { auth, packages, audit } = getContainer();
    const principal = await auth.resolveWeb(req);
    auth.assertCanAdministerPlatform(principal);
    const subject = await auth.subjectOf(principal);
    const body = (await req.json().catch(() => null)) as {
      definition?: PackageDefinition;
      expectedVersion?: unknown;
    } | null;
    if (
      !body?.definition ||
      !(
        body.expectedVersion === null ||
        (typeof body.expectedVersion === "number" &&
          Number.isSafeInteger(body.expectedVersion) &&
          body.expectedVersion > 0)
      )
    ) {
      return Response.json({ error: "须提供套餐定义和 expectedVersion" }, { status: 400 });
    }
    const saved = await packages.save(body.definition, body.expectedVersion, subject.userId);
    await audit.record({
      actor: principal,
      action: "billing.package_update",
      resource: { type: "package", id: saved.id },
      details: { name: saved.name, version: saved.version, enabled: saved.enabled },
      req,
    });
    return Response.json({ package: saved }, { status: 201 });
  } catch (err) {
    const response = authErrorResponse(err);
    if (response) return response;
    if (err instanceof BillingError)
      return Response.json(
        {
          error: err.message,
          code: err.code,
        },
        { status: err.status },
      );
    throw err;
  }
}
