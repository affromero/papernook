import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  activeProfile,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/lib/auth/session";
import { GATE_COOKIE, gateCookieOptions } from "@/lib/auth/gate";
import { forgetAccountRateLimit } from "@/lib/auth/rate-limit";
import {
  deleteProfile,
  isAdmin,
  ProfileError,
  verifyProfilePassword,
} from "@/lib/auth/users";
import { beginProfileErasure } from "@/lib/auth/profile-activity";
import { readBoundedJsonOrNull } from "@/lib/bounded-request";

/** Complete self-erasure or admin-managed member erasure. */

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ username: string }>;
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const me = await activeProfile();
  if (!me)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { username } = await params;
  if (me.username !== username && !isAdmin(me)) {
    return NextResponse.json(
      { error: "You can delete only your own profile." },
      { status: 403 },
    );
  }
  const body = z
    .object({
      confirmation: z.string(),
      password: z.string().max(200).optional(),
    })
    .safeParse(await readBoundedJsonOrNull(request));
  if (!body.success || body.data.confirmation !== username) {
    return NextResponse.json(
      { error: `Type ${username} to confirm complete deletion.` },
      { status: 400 },
    );
  }
  if (
    me.passwordHash &&
    !(await verifyProfilePassword(me, body.data.password ?? ""))
  ) {
    return NextResponse.json(
      { error: "Your profile password is required." },
      { status: 401 },
    );
  }
  try {
    const finishErasure = await beginProfileErasure(username);
    try {
      forgetAccountRateLimit(username);
      deleteProfile(username);
    } finally {
      finishErasure();
    }
    const response = NextResponse.json({ ok: true });
    if (me.username === username) {
      response.cookies.set(SESSION_COOKIE, "", {
        ...sessionCookieOptions(),
        maxAge: 0,
      });
      response.cookies.set(GATE_COOKIE, "", {
        ...gateCookieOptions(),
        maxAge: 0,
      });
    }
    return response;
  } catch (err) {
    if (err instanceof ProfileError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
