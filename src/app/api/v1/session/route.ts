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
import { requestIsPublic } from "@/lib/auth/exposure";
import {
  recordFailure,
  recordSuccess,
  retryAfterMs,
} from "@/lib/auth/rate-limit";

const loginSchema = z.object({
  username: z.string().min(2).max(31),
  /** Optional direct-API alternative to first passing the shared gate. */
  password: z.string().max(200).optional(),
});

function clientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local"
  );
}

export async function GET(): Promise<NextResponse> {
  const profile = await activeProfile();
  return NextResponse.json({
    profile: profile ? toPublicProfile(profile) : null,
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = loginSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: "Invalid login." }, { status: 400 });
  }
  const { username, password } = body.data;
  const profile = getProfile(username);
  if (!profile) {
    return NextResponse.json({ error: "Unknown profile." }, { status: 404 });
  }

  if (await requestIsPublic()) {
    if (!instancePasswordConfigured()) {
      return NextResponse.json(
        {
          error:
            "Public access is not configured. The admin must set PAPERNOOK_PASSWORD.",
        },
        { status: 503 },
      );
    }
    const ipKey = `ip:${clientIp(request)}`;
    const accountKey = `user:${username}`;
    const wait = Math.max(retryAfterMs(ipKey), retryAfterMs(accountKey));
    if (wait > 0) {
      return NextResponse.json(
        { error: "Too many attempts. Try again later." },
        {
          status: 429,
          headers: { "Retry-After": String(Math.ceil(wait / 1000)) },
        },
      );
    }

    // A valid gate cookie already proved the admin-created password. Direct
    // API clients may supply that same instance password with the login.
    if (!(await gatePassed())) {
      if (!password || !verifyInstancePassword(password)) {
        recordFailure(ipKey);
        recordFailure(accountKey);
        return NextResponse.json({ error: "Wrong password." }, { status: 401 });
      }
    }
    recordSuccess(ipKey);
    recordSuccess(accountKey);
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
