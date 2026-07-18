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

/**
 * Verify the instance access password and set the gate cookie. This is the
 * front door on a public instance: brute-force protected by the shared
 * per-IP lockout.
 */

export const dynamic = "force-dynamic";

const schema = z.object({ password: z.string().min(1).max(200) });

function clientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local"
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ipKey = `gate:${clientIp(request)}`;
  const wait = retryAfterMs(ipKey);
  if (wait > 0) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(wait / 1000)) },
      },
    );
  }
  const body = schema.safeParse(await request.json().catch(() => null));
  if (!body.success || !verifyInstancePassword(body.data.password)) {
    recordFailure(ipKey);
    return NextResponse.json({ error: "Wrong password." }, { status: 401 });
  }
  recordSuccess(ipKey);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(GATE_COOKIE, createGateToken(), gateCookieOptions());
  return response;
}
