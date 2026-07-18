import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  getProfile,
  setPassword,
  verifyPassword,
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
  /** Required in public mode; ignored in private mode. */
  password: z.string().max(200).optional(),
  /** First login in public mode on a passwordless profile sets the password. */
  newPassword: z.string().min(8).max(200).optional(),
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
  const { username, password, newPassword } = body.data;
  const profile = getProfile(username);
  if (!profile) {
    return NextResponse.json({ error: "Unknown profile." }, { status: 404 });
  }

  if (await requestIsPublic()) {
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

    if (instancePasswordConfigured()) {
      // Instance password is THE password. A valid gate cookie already
      // proved it, so a gated request logs in directly; otherwise the
      // password must be supplied here.
      if (!(await gatePassed())) {
        if (!password || !verifyInstancePassword(password)) {
          recordFailure(ipKey);
          recordFailure(accountKey);
          return NextResponse.json(
            { error: "Wrong password." },
            { status: 401 },
          );
        }
      }
    } else if (profile.passwordHash === null) {
      // Public mode + passwordless profile: first login must set a password.
      if (!newPassword) {
        return NextResponse.json(
          { error: "This profile must set a password.", mustSetPassword: true },
          { status: 403 },
        );
      }
      await setPassword(username, newPassword);
    } else if (!password || !(await verifyPassword(username, password))) {
      recordFailure(ipKey);
      recordFailure(accountKey);
      return NextResponse.json({ error: "Wrong password." }, { status: 401 });
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
