import { NextResponse, type NextRequest } from "next/server";
import { activeProfile } from "@/lib/auth/session";
import { deleteProfile, isAdmin, ProfileError } from "@/lib/auth/users";

/** Admin-only member management. */

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ username: string }>;
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const me = await activeProfile();
  if (!me)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!isAdmin(me)) {
    return NextResponse.json({ error: "Admin only." }, { status: 403 });
  }
  const { username } = await params;
  try {
    deleteProfile(username);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ProfileError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
