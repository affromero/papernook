import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requestIdentity, accessFailure } from "@/lib/auth/access";
import {
  AgentMetrics,
  metricRuntimeStatus,
} from "@/lib/agent/platform/metrics";
import { dataRoot } from "@/lib/data-dir";
import { metricRetentionStatus } from "@/lib/agent/platform/metric-retention";

export const dynamic = "force-dynamic";

const querySchema = z
  .object({
    scope: z.enum(["profile", "instance"]).default("profile"),
    since: z.coerce
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(100),
  })
  .strict();

function json(body: object, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const admission = await requestIdentity();
    if (!admission?.capability) return json({ error: "Not signed in." }, 401);
    const keys = [...request.nextUrl.searchParams.keys()];
    if (new Set(keys).size !== keys.length)
      return json({ error: "Repeated metric query parameter." }, 400);
    const query = querySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    if (!query.success) return json({ error: "Invalid metric query." }, 400);
    const instance = query.data.scope === "instance";
    if (instance && !admission.isAdmin)
      return json({ error: "Admin only." }, 403);
    const metrics = new AgentMetrics(dataRoot());
    const filter = { since: query.data.since, limit: query.data.limit };
    const events = instance
      ? await metrics.queryInstance(filter)
      : await metrics.queryProfile(admission.capability, filter);
    const current = await requestIdentity(admission.token);
    if (
      !current?.capability ||
      current.capability.username !== admission.capability.username ||
      current.capability.generation !== admission.capability.generation
    )
      return json({ error: "Session changed. Sign in again." }, 401);
    if (instance && !current.isAdmin)
      return json({ error: "Admin only." }, 403);
    return json({
      events,
      ...(instance
        ? {
            diagnostics: {
              ...metricRuntimeStatus(),
              retention: metricRetentionStatus(),
            },
          }
        : {}),
    });
  } catch (error) {
    const response = accessFailure(error);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }
}
