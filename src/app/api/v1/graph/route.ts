import { NextResponse } from "next/server";
import { activeProfile } from "@/lib/auth/session";
import { consumeRequestLimit } from "@/lib/auth/rate-limit";
import { buildLibraryGraph } from "@/lib/library/graph";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const profile = await activeProfile();
  if (!profile)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const wait = consumeRequestLimit(`graph:${profile.username}`, 30, 60_000);
  if (wait > 0) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }
  return NextResponse.json(buildLibraryGraph());
}
