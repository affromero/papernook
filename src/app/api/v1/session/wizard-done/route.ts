import { NextResponse } from "next/server";
import { activeProfile } from "@/lib/auth/session";
import { markWizardDone } from "@/lib/auth/users";

export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  const profile = await activeProfile();
  if (!profile)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  markWizardDone(profile.username);
  return NextResponse.json({ ok: true });
}
