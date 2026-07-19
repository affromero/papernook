import { NextResponse } from "next/server";
import { z } from "zod";
import { ANIMAL_AVATARS } from "@/lib/auth/avatars";
import {
  createProfile,
  listProfiles,
  toPublicProfile,
  ProfileError,
  instancePasswordConfigured,
  verifyInstancePassword,
} from "@/lib/auth/users";
import { activeProfile } from "@/lib/auth/session";
import { gatePassed } from "@/lib/auth/gate";
import { requestIsPublic } from "@/lib/auth/exposure";
import {
  recordFailure,
  recordSuccess,
  retryAfterMs,
} from "@/lib/auth/rate-limit";

export async function GET(): Promise<NextResponse> {
  // Behind the gate on a public instance, do not leak profile names.
  if (
    (await requestIsPublic()) &&
    !(await activeProfile()) &&
    !(await gatePassed())
  ) {
    return NextResponse.json({
      profiles: [],
      instancePassword: instancePasswordConfigured(),
      gated: true,
    });
  }
  return NextResponse.json({
    profiles: listProfiles().map(toPublicProfile),
    instancePassword: instancePasswordConfigured(),
  });
}

const createSchema = z.object({
  displayName: z.string().min(2).max(40),
  avatarSlug: z
    .enum(ANIMAL_AVATARS.map((a) => a.slug) as [string, ...string[]])
    .optional(),
  /** Required in public mode without a session (self-registration gate). */
  password: z.string().max(200).optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const body = createSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: "Invalid profile." }, { status: 400 });
  }
  // Public exposure: strangers must not self-register. Creation needs an
  // existing session, or the instance password when one is configured.
  // The password check shares the login lockout so it cannot be
  // brute-forced from this endpoint either.
  if (
    (await requestIsPublic()) &&
    !(await activeProfile()) &&
    !(await gatePassed())
  ) {
    const ipKey = `ip:${request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local"}`;
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
    const allowed =
      instancePasswordConfigured() &&
      verifyInstancePassword(body.data.password ?? "");
    if (!allowed) {
      recordFailure(ipKey);
      return NextResponse.json(
        {
          error: instancePasswordConfigured()
            ? "The access password is required to create a profile."
            : "Public access is not configured. The admin must set PAPERNOOK_PASSWORD.",
        },
        { status: instancePasswordConfigured() ? 403 : 503 },
      );
    }
    recordSuccess(ipKey);
  }
  try {
    const profile = createProfile(body.data.displayName, body.data.avatarSlug);
    return NextResponse.json(
      { profile: toPublicProfile(profile) },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof ProfileError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
