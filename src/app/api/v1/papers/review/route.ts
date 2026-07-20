import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { readBoundedJsonOrNull } from "@/lib/bounded-request";
import { activeProfile } from "@/lib/auth/session";
import { isValidSlug } from "@/lib/library/slug";
import { clearNeedsReview, movePaper } from "@/lib/library/papers";
import { rebuildIndex } from "@/lib/library/index-db";

/**
 * Review a sync-imported paper: keep it where the AI filed it (clears the
 * needsReview flag) or re-file it into another topic first.
 */

export const dynamic = "force-dynamic";

const slug = z.string().refine(isValidSlug, "Invalid slug.");
const schema = z.object({
  topic: slug,
  slug,
  moveTo: slug.optional(),
});

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const me = await activeProfile();
  if (!me)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const body = schema.safeParse(await readBoundedJsonOrNull(request));
  if (!body.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    let topic = body.data.topic;
    if (body.data.moveTo && body.data.moveTo !== topic) {
      topic = movePaper(topic, body.data.slug, body.data.moveTo).topic ?? topic;
    }
    clearNeedsReview(topic, body.data.slug);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Review failed." },
      { status: 404 },
    );
  }
  rebuildIndex();
  return NextResponse.json({ ok: true });
}
