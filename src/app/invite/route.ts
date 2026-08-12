import { NextResponse, type NextRequest } from "next/server";
import {
  verifyInviteToken,
  createGateToken,
  gateCookieOptions,
  GATE_COOKIE,
} from "@/lib/auth/gate";

/**
 * Invite links: /invite?t=<signed token>. A valid invite opens the gate
 * (sets the gate cookie) and lands on the picker; no password typing.
 * Invites expire after 7 days and die with a SESSION_SECRET rotation.
 */

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Redirect to a path-only Location: the browser resolves it against the
  // public request URL, so we never trust a (spoofable) Host header to build
  // an absolute URL — which would otherwise be an open redirect on a
  // directly-exposed (non-Caddy) deployment.
  const token = request.nextUrl.searchParams.get("t") ?? "";
  const response = new NextResponse(null, {
    status: 302,
    headers: { location: "/login" },
  });
  if (verifyInviteToken(token)) {
    response.cookies.set(GATE_COOKIE, createGateToken(), gateCookieOptions());
  }
  return response;
}
