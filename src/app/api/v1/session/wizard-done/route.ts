import { NextResponse } from "next/server";
import { requestIdentity } from "@/lib/auth/access";
import { markWizardDone } from "@/lib/auth/users";

export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  const identity = await requestIdentity();
  if (!identity?.profile)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  await markWizardDone(identity.profile.username, identity.token);
  return NextResponse.json({ ok: true });
}
