import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { activeProfile } from "@/lib/auth/session";
import { consumeRequestLimit } from "@/lib/auth/rate-limit";
import { LookupFailedError } from "@/lib/capture/arxiv/atom";
import { resolveReferenceUrl } from "@/lib/library/context/reference-resolve";

export const dynamic = "force-dynamic";

/**
 * Resolve a bibliography entry to a capturable URL so a reference popover
 * can offer "Add to library" for a cited work that is not in the library
 * yet. The body of the work happens server-side (arXiv lookups are polite,
 * cached, and never expose the reader's browser to a third party). A miss
 * is `{ url: null }`; an arXiv outage or timeout is a 502 so the client
 * shows "Failed · retry" instead of a definitive "not found".
 */

const querySchema = z.object({ q: z.string().min(12).max(400) });

export async function GET(request: NextRequest): Promise<NextResponse> {
  const profile = await activeProfile();
  if (!profile)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const parsed = querySchema.safeParse({
    q: request.nextUrl.searchParams.get("q") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid reference." }, { status: 400 });
  }
  const wait = consumeRequestLimit(
    `citation-resolve:${profile.username}`,
    60,
    10 * 60_000,
  );
  if (wait > 0) {
    return NextResponse.json({ error: "Too many lookups." }, { status: 429 });
  }
  try {
    const resolved = await resolveReferenceUrl(parsed.data.q);
    return NextResponse.json(
      resolved ? { url: resolved.url, title: resolved.title } : { url: null },
    );
  } catch (error) {
    if (error instanceof LookupFailedError) {
      return NextResponse.json(
        { error: "The lookup did not complete; try again." },
        { status: 502 },
      );
    }
    throw error;
  }
}
