import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import {
  type CapabilityDefinition,
  validateCapability,
} from "@/lib/modules/capabilities/domain/catalog";
import { CapabilityConflict } from "@/lib/modules/capabilities/ports";
import { EnvModelGateway } from "@/lib/modules/model-gateway/adapters/env-gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { auth, capabilities, env } = getContainer();
  try {
    const principal = await auth.resolveWeb(req);
    const manage = new URL(req.url).searchParams.get("manage") === "1";
    if (manage) auth.assertCanAdministerPlatform(principal);
    const slots = new EnvModelGateway(env.models).slots();
    const models = new Set(Object.values(slots));
    const catalog = await capabilities.list(manage);
    return Response.json(
      {
        capabilities: catalog.map((capability) => ({
          ...(manage
            ? capability
            : {
                id: capability.id,
                name: capability.name,
                kind: capability.kind,
                acceptsImages: capability.acceptsImages,
                rates: capability.rates,
                version: capability.version,
              }),
          available:
            capability.enabled &&
            capability.kind === "llm" &&
            models.has(capability.modelId) &&
            !!env.defaultApiKey.trim() &&
            !!env.defaultBaseUrl?.trim(),
        })),
        ...(manage ? { modelSlots: slots } : {}),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const response = authErrorResponse(err);
    if (response) return response;
    throw err;
  }
}

export async function POST(req: Request) {
  const { auth, capabilities, audit } = getContainer();
  try {
    const principal = await auth.resolveWeb(req);
    auth.assertCanAdministerPlatform(principal);
    const subject = await auth.subjectOf(principal);
    const body = (await req.json().catch(() => null)) as {
      definition?: unknown;
      expectedVersion?: unknown;
    } | null;
    if (
      !body ||
      !(
        body.expectedVersion === null ||
        (typeof body.expectedVersion === "number" &&
          Number.isSafeInteger(body.expectedVersion) &&
          body.expectedVersion > 0)
      )
    ) {
      return Response.json({ error: "expectedVersion 须为 null 或正整数" }, { status: 400 });
    }
    let definition: CapabilityDefinition;
    try {
      definition = validateCapability(body.definition);
    } catch (err) {
      return Response.json({ error: (err as Error).message }, { status: 400 });
    }
    const saved = await capabilities.save(definition, body.expectedVersion, subject.userId);
    await audit.record({
      actor: principal,
      action: "capability.update",
      resource: { type: "capability", id: saved.id },
      ownerId: subject.userId,
      details: {
        name: saved.name,
        kind: saved.kind,
        version: saved.version,
        enabled: saved.enabled,
      },
      req,
    });
    return Response.json({ capability: saved }, { status: 201 });
  } catch (err) {
    const response = authErrorResponse(err);
    if (response) return response;
    if (err instanceof CapabilityConflict)
      return Response.json(
        {
          error: err.message,
          code: "conflict",
        },
        { status: 409 },
      );
    throw err;
  }
}
