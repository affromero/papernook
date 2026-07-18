import { NextResponse } from "next/server";
import { listPapers, listInbox } from "@/lib/library/papers";
import {
  configuredProviderId,
  isProviderAvailable,
} from "@/lib/agent/registry";

/**
 * Unauthenticated health endpoint for deploy verification and uptime
 * checks. Reports liveness + non-sensitive counters only.
 */

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  let provider: string | null = null;
  let agentAvailable = false;
  try {
    provider = configuredProviderId();
    agentAvailable = await isProviderAvailable(
      provider as Parameters<typeof isProviderAvailable>[0],
    );
  } catch {
    // unconfigured — still healthy, just report it
  }
  return NextResponse.json({
    status: "healthy",
    version: process.env.PAPERNOOK_VERSION ?? "dev",
    papers: listPapers().length,
    inbox: listInbox().length,
    agent: { provider, available: agentAvailable },
  });
}
