import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  activeProfile,
  createSessionToken,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/lib/auth/session";
import {
  getProfile,
  ProfileError,
  setProfilePassword,
  verifyProfilePassword,
} from "@/lib/auth/users";
import { rejectCrossSiteMutation } from "@/lib/auth/request-security";
import { readBoundedJsonOrNull } from "@/lib/bounded-request";

const schema = z.object({
  currentPassword: z.string().max(200).optional(),
  newPassword: z.string().min(12).max(200),
});

interface Params {
  params: Promise<{ username: string }>;
}

export async function PUT(request: NextRequest, { params }: Params) {
  const crossSite = rejectCrossSiteMutation(request);
  if (crossSite) return crossSite;
  const active = await activeProfile();
  const { username } = await params;
  if (!active)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (active.username !== username) {
    return NextResponse.json(
      { error: "You can change only your own password." },
      { status: 403 },
    );
  }
  const body = schema.safeParse(await readBoundedJsonOrNull(request));
  if (!body.success) {
    return NextResponse.json({ error: "Invalid password." }, { status: 400 });
  }
  const profile = getProfile(username);
  if (
    profile?.passwordHash &&
    !(await verifyProfilePassword(profile, body.data.currentPassword ?? ""))
  ) {
    return NextResponse.json(
      { error: "Current password is wrong." },
      { status: 401 },
    );
  }
  try {
    setProfilePassword(username, body.data.newPassword);
    const response = NextResponse.json({ ok: true });
    response.cookies.set(
      SESSION_COOKIE,
      createSessionToken(username),
      sessionCookieOptions(),
    );
    return response;
  } catch (error) {
    if (error instanceof ProfileError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
