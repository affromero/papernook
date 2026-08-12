import { NextResponse, type NextRequest } from "next/server";
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
import {
  recordFailure,
  recordSuccess,
  retryAfterMs,
} from "@/lib/auth/rate-limit";
import { clientIp, rejectCrossSiteMutation } from "@/lib/auth/request-security";
import { readBoundedJsonOrNull } from "@/lib/bounded-request";

export async function GET(): Promise<NextResponse> {
  // Behind the gate, do not leak profile names.
  if (!(await activeProfile()) && !(await gatePassed())) {
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

export async function POST(request: NextRequest): Promise<NextResponse> {
  const crossSite = rejectCrossSiteMutation(request);
  if (crossSite) return crossSite;
  const body = createSchema.safeParse(await readBoundedJsonOrNull(request));
  if (!body.success) {
    return NextResponse.json({ error: "Invalid profile." }, { status: 400 });
  }
  // Public exposure: strangers must not self-register. Creation needs an
  // existing session, or the instance password when one is configured.
  // The password check shares the login lockout so it cannot be
  // brute-forced from this endpoint either.
  if (!(await activeProfile()) && !(await gatePassed())) {
    const ipKey = `ip:${clientIp(request)}`;
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
