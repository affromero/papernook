import { NextResponse } from "next/server";

/**
 * Dependency-free liveness endpoint for orchestrators. Readiness and provider
 * details live behind authenticated endpoints.
 */

export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  return NextResponse.json(
    {
      status: "ok",
      version: process.env.PAPERNOOK_VERSION ?? "dev",
    },
    {
      headers: { "Cache-Control": "no-store" },
    },
  );
}
