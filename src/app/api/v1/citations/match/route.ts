import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { activeProfile } from "@/lib/auth/session";
import { consumeRequestLimit } from "@/lib/auth/rate-limit";
import { findPaperByReference } from "@/lib/library/context/reference-match";

export const dynamic = "force-dynamic";

/**
 * Resolve a bibliography entry (extracted from a PDF's reference list) to a
 * confirmed paper in the library, so the reference popover can offer
 * "in your library" instead of a web search.
 */

const querySchema = z.string().min(12).max(400);

export async function GET(request: NextRequest): Promise<NextResponse> {
  const profile = await activeProfile();
  if (!profile)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const parsed = querySchema.safeParse(request.nextUrl.searchParams.get("q"));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid reference." }, { status: 400 });
  }
  const wait = consumeRequestLimit(
    `citation-match:${profile.username}`,
    120,
    10 * 60_000,
  );
  if (wait > 0) {
    return NextResponse.json({ error: "Too many lookups." }, { status: 429 });
  }
  const match = findPaperByReference(parsed.data);
  return NextResponse.json({
    match: match
      ? { topic: match.topic, slug: match.slug, title: match.title }
      : null,
  });
}
