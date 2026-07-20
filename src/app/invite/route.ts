import { NextResponse, type NextRequest } from "next/server";
import {
  verifyInviteToken,
  createGateToken,
  gateCookieOptions,
  GATE_COOKIE,
} from "@/lib/auth/gate";
import { isPublicExposure } from "@/lib/data-dir";

/**
 * Invite links: /invite?t=<signed token>. A valid invite opens the gate
 * (sets the gate cookie) and lands on the picker; no password typing.
 * Invites expire after 7 days and die with a SESSION_SECRET rotation.
 */

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Behind Caddy the request URL carries the internal container host;
  // rebuild the redirect from the forwarded headers.
  const proto = request.headers.get("x-forwarded-proto") ?? "http";
  const host = request.headers.get("host") ?? request.nextUrl.host;
  const login = `${proto}://${host}/login`;
  const token = request.nextUrl.searchParams.get("t") ?? "";
  const response = NextResponse.redirect(login, 302);
  if (!isPublicExposure() && verifyInviteToken(token)) {
    response.cookies.set(GATE_COOKIE, createGateToken(), gateCookieOptions());
  }
  return response;
}
