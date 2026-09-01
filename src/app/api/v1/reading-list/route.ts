import { NextResponse } from "next/server";
import { activeProfile } from "@/lib/auth/session";
import { consumeRequestLimit } from "@/lib/auth/rate-limit";
import { buildReadingList } from "@/lib/library/bibliography/reading-list";

export const dynamic = "force-dynamic";

/**
 * Deterministic "cited in your library" reading list for the Discover page.
 * Rebuilt from disk per request (same cost class as the graph route), so it
 * gets the same modest per-user throttle.
 */
export async function GET(): Promise<NextResponse> {
  const profile = await activeProfile();
  if (!profile)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const wait = consumeRequestLimit(
    `reading-list:${profile.username}`,
    10,
    60_000,
  );
  if (wait > 0) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }
  return NextResponse.json({ items: buildReadingList() });
}
