import { NextResponse } from "next/server";
import { activeProfile } from "@/lib/auth/session";
import {
  isProviderAvailable,
  configuredProviderId,
} from "@/lib/agent/registry";

/** Wizard live-test: is the configured agent reachable right now? */

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const profile = await activeProfile();
  if (!profile)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  try {
    const provider = configuredProviderId();
    const available = await isProviderAvailable(provider);
    return NextResponse.json({ provider, available });
  } catch (err) {
    return NextResponse.json({
      provider: null,
      available: false,
      error: err instanceof Error ? err.message : "Not configured.",
    });
  }
}
