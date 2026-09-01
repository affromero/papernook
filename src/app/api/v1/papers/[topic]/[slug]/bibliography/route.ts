import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isValidSlug } from "@/lib/library/slug";
import { activeProfile } from "@/lib/auth/session";
import { consumeRequestLimit } from "@/lib/auth/rate-limit";
import { readBoundedJsonOrNull } from "@/lib/bounded-request";
import {
  bibliographySchema,
  readBibliography,
  writeBibliography,
} from "@/lib/library/bibliography/store";
import { getPaper } from "@/lib/library/papers";

export const dynamic = "force-dynamic";

/**
 * Server-side bibliography cache for a paper. The PDF reader PUTs its
 * scanned bibliography once per document open; the canvas chat (no mounted
 * reader) and the library graph GET it back. The library is shared, so any
 * signed-in profile may write; last write wins — every writer derives the
 * same content from the same PDF.
 */

const paramsSchema = z
  .object({
    topic: z.string().refine(isValidSlug),
    slug: z.string().refine(isValidSlug),
  })
  .strict();

interface Params {
  params: Promise<{ topic: string; slug: string }>;
}

export async function GET(_request: NextRequest, { params }: Params) {
  const profile = await activeProfile();
  if (!profile)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const routeParams = paramsSchema.safeParse(await params);
  if (!routeParams.success) {
    return NextResponse.json({ error: "Invalid paper." }, { status: 400 });
  }
  const { topic, slug } = routeParams.data;
  if (!getPaper(topic, slug))
    return NextResponse.json({ error: "Unknown paper." }, { status: 404 });
  return NextResponse.json({ bibliography: readBibliography(topic, slug) });
}

export async function PUT(request: NextRequest, { params }: Params) {
  const profile = await activeProfile();
  if (!profile)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const routeParams = paramsSchema.safeParse(await params);
  if (!routeParams.success) {
    return NextResponse.json({ error: "Invalid paper." }, { status: 400 });
  }
  const { topic, slug } = routeParams.data;
  if (!getPaper(topic, slug))
    return NextResponse.json({ error: "Unknown paper." }, { status: 404 });
  const wait = consumeRequestLimit(
    `bibliography-write:${profile.username}`,
    30,
    10 * 60_000,
  );
  if (wait > 0) {
    return NextResponse.json({ error: "Too many writes." }, { status: 429 });
  }
  const body = bibliographySchema.safeParse(
    await readBoundedJsonOrNull(request, 4 * 1024 * 1024),
  );
  if (!body.success) {
    return NextResponse.json(
      { error: "Invalid bibliography." },
      { status: 400 },
    );
  }
  writeBibliography(topic, slug, body.data);
  return NextResponse.json({ ok: true });
}
