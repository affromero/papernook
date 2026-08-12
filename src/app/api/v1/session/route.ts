import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  getProfile,
  toPublicProfile,
  instancePasswordConfigured,
  verifyInstancePassword,
} from "@/lib/auth/users";
import {
  createSessionToken,
  sessionCookieOptions,
  SESSION_COOKIE,
  activeProfile,
} from "@/lib/auth/session";
import { gatePassed, GATE_COOKIE, gateCookieOptions } from "@/lib/auth/gate";
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

const loginSchema = z.object({
  username: z.string().min(2).max(31),
  /** Direct API clients may prove the gate without a gate cookie. */
  accessPassword: z.string().max(200).optional(),
});

export async function GET(): Promise<NextResponse> {
  const profile = await activeProfile();
  return NextResponse.json({
    profile: profile ? toPublicProfile(profile) : null,
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const crossSite = rejectCrossSiteMutation(request);
  if (crossSite) return crossSite;
  const body = loginSchema.safeParse(await readBoundedJsonOrNull(request));
  if (!body.success) {
    return NextResponse.json({ error: "Invalid login." }, { status: 400 });
  }
  const { username, accessPassword } = body.data;

  // The instance password is the only credential, so it is checked on every
  // login — there is no mode in which a session is issued without it.
  if (!instancePasswordConfigured()) {
    return NextResponse.json(
      {
        error:
          "Access is not configured. The admin must set PAPERNOOK_PASSWORD.",
      },
      { status: 503 },
    );
  }
  // Throttle instance-password guessing per client. A per-username lockout
  // would guard nothing (profiles have no credential) while letting an
  // unauthenticated caller disable a named profile for everyone.
  //
  // Only clients we can actually identify get a lockout bucket. Without a
  // trusted proxy every caller resolves to "unknown", and locking that shared
  // bucket would let one attacker shut the whole instance out. Guessing is
  // still bounded there by the per-request failure delay and the global
  // request limit in the proxy.
  const ipKey = lockoutKey(request, "ip");
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

  if (!(await gatePassed())) {
    if (!accessPassword || !verifyInstancePassword(accessPassword)) {
      if (ipKey) recordFailure(ipKey);
      await authenticationFailureDelay();
      return NextResponse.json({ error: "Invalid login." }, { status: 401 });
    }
    if (ipKey) recordSuccess(ipKey);
  }

  const profile = getProfile(username);
  if (!profile) {
    return NextResponse.json({ error: "Invalid login." }, { status: 401 });
  }

  const response = NextResponse.json({ profile: toPublicProfile(profile) });
  response.cookies.set(
    SESSION_COOKIE,
    createSessionToken(username),
    sessionCookieOptions(),
  );
  return response;
}

export async function DELETE(): Promise<NextResponse> {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", {
    ...sessionCookieOptions(),
    maxAge: 0,
  });
  // Logging out closes the gate too: the next visit asks for the password.
  response.cookies.set(GATE_COOKIE, "", { ...gateCookieOptions(), maxAge: 0 });
  return response;
}
