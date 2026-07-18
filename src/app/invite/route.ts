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
  const token = request.nextUrl.searchParams.get("t") ?? "";
  if (!verifyInviteToken(token)) {
    return NextResponse.redirect(new URL("/login", request.nextUrl), 302);
  }
  const response = NextResponse.redirect(
    new URL("/login", request.nextUrl),
    302,
  );
  response.cookies.set(GATE_COOKIE, createGateToken(), gateCookieOptions());
  return response;
}
