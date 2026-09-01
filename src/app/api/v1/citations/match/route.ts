import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { activeProfile } from "@/lib/auth/session";
import { consumeRequestLimit } from "@/lib/auth/rate-limit";
import { normalizeUrl } from "@/lib/capture/normalize";
import { findPaperByReference } from "@/lib/library/context/reference-match";
import { findPaperBySource } from "@/lib/library/papers";

export const dynamic = "force-dynamic";

/**
 * Resolve a cited work to a confirmed paper in the library, so a reference
 * popover or a chat sources card can offer "in your library" instead of a
 * web search or a capture. Two lookups, exactly one per request:
 *  - `q`: a bibliography entry extracted from a PDF's reference list.
 *  - `url`: an arXiv / DOI / publisher link the assistant cited.
 * Inbox papers never match — they are unconfirmed and private to whoever
 * captured them.
 */

const querySchema = z
  .object({
    q: z.string().min(12).max(400).optional(),
    url: z.string().url().max(2000).optional(),
  })
  .refine((query) => (query.q === undefined) !== (query.url === undefined), {
    message: "Pass exactly one of q or url.",
  });

interface Match {
  topic: string;
  slug: string;
  title: string;
}

function matchByUrl(url: string, username: string): Match | null {
  let arxivId: string | null = null;
  try {
    arxivId = normalizeUrl(url).arxivId;
  } catch {
    arxivId = null;
  }
  const paper = findPaperBySource(url, arxivId, username);
  if (!paper || paper.topic === null) return null;
  return { topic: paper.topic, slug: paper.slug, title: paper.meta.title };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const profile = await activeProfile();
  if (!profile)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const params = request.nextUrl.searchParams;
  const parsed = querySchema.safeParse({
    q: params.get("q") ?? undefined,
    url: params.get("url") ?? undefined,
  });
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
  let match: Match | null;
  if (parsed.data.q !== undefined) {
    const found = findPaperByReference(parsed.data.q);
    // findPaperByReference already skips inbox papers; the guard narrows the type.
    match =
      found && found.topic !== null
        ? { topic: found.topic, slug: found.slug, title: found.title }
        : null;
  } else {
    match = matchByUrl(parsed.data.url ?? "", profile.username);
  }
  return NextResponse.json({ match });
}
