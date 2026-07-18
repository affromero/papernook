import { NextResponse } from "next/server";
import { activeProfile } from "@/lib/auth/session";
import { buildLibraryGraph } from "@/lib/library/graph";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const profile = await activeProfile();
  if (!profile)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  return NextResponse.json(buildLibraryGraph());
}
