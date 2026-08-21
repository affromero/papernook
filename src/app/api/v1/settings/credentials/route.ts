import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  credentialReloadAvailable,
  reloadProviderCredentials,
} from "@/lib/agent/credentials";
import {
  configuredProviderId,
  providerStatus,
  resetProviderStatusCache,
} from "@/lib/agent/registry";
import { readBoundedJsonOrNull } from "@/lib/bounded-request";
import { activeProfile } from "@/lib/auth/session";
import { isAdmin } from "@/lib/auth/users";

export const dynamic = "force-dynamic";

const schema = z.object({});

function json(body: object, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const profile = await activeProfile();
  if (!profile) return json({ error: "Not signed in." }, 401);
  if (!isAdmin(profile)) return json({ error: "Admin only." }, 403);
  const body = schema.safeParse(await readBoundedJsonOrNull(request));
  if (!body.success) return json({ error: "Invalid request." }, 400);
  try {
    const provider = configuredProviderId();
    if (!credentialReloadAvailable(provider)) {
      return json(
        { error: "Credential reload is unavailable for this provider." },
        409,
      );
    }
    const outcome = await reloadProviderCredentials(provider);
    resetProviderStatusCache();
    return json({
      provider,
      outcome,
      readiness: await providerStatus(provider),
    });
  } catch (error) {
    console.error(
      "CLI credential reload failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    return json({ error: "Could not reload CLI credentials." }, 503);
  }
}
