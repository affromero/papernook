import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { verifyInstancePassword } from "@/lib/auth/users";
import {
  createGateToken,
  gateCookieOptions,
  GATE_COOKIE,
} from "@/lib/auth/gate";
import {
  recordFailure,
  recordSuccess,
  retryAfterMs,
} from "@/lib/auth/rate-limit";
import {
  authenticationFailureDelay,
  lockoutKey,
  rejectCrossSiteMutation,
} from "@/lib/auth/request-security";
import { readBoundedJsonOrNull } from "@/lib/bounded-request";

/**
 * Verify the instance access password and set the gate cookie. This is the
 * front door on a public instance: brute-force protected by the shared
 * per-IP lockout.
 */

export const dynamic = "force-dynamic";

const schema = z.object({ password: z.string().min(1).max(200) });

export async function POST(request: NextRequest): Promise<NextResponse> {
  const crossSite = rejectCrossSiteMutation(request);
  if (crossSite) return crossSite;
  const ipKey = lockoutKey(request, "gate");
  const wait = ipKey ? retryAfterMs(ipKey) : 0;
  if (wait > 0) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(wait / 1000)) },
      },
    );
  }
  const body = schema.safeParse(await readBoundedJsonOrNull(request));
  if (!body.success || !verifyInstancePassword(body.data.password)) {
    if (ipKey) recordFailure(ipKey);
    await authenticationFailureDelay();
    return NextResponse.json({ error: "Wrong password." }, { status: 401 });
  }
  if (ipKey) recordSuccess(ipKey);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(GATE_COOKIE, createGateToken(), gateCookieOptions());
  return response;
}
