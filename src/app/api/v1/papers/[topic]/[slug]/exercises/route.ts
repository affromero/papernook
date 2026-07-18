import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { activeProfile } from "@/lib/auth/session";
import { getPaper } from "@/lib/library/papers";
import {
  saveExercise,
  listExercises,
  renderExercisesPdf,
} from "@/lib/library/exercises";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ topic: string; slug: string }>;
}

export async function GET(_req: NextRequest, { params }: Params) {
  const profile = await activeProfile();
  if (!profile)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { topic, slug } = await params;
  if (!getPaper(topic, slug)) {
    return NextResponse.json({ error: "Unknown paper." }, { status: 404 });
  }
  return NextResponse.json({ exercises: listExercises(topic, slug) });
}

const saveSchema = z.object({ markdown: z.string().min(1).max(100_000) });

/** Save a markdown exercise and re-render <slug>.exercises.pdf for WebDAV. */
export async function POST(request: NextRequest, { params }: Params) {
  const profile = await activeProfile();
  if (!profile)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { topic, slug } = await params;
  const paper = getPaper(topic, slug);
  if (!paper)
    return NextResponse.json({ error: "Unknown paper." }, { status: 404 });
  const body = saveSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: "Invalid exercise." }, { status: 400 });
  }
  const name = saveExercise(topic, slug, body.data.markdown);
  await renderExercisesPdf(topic, slug, paper.meta.title);
  return NextResponse.json({ saved: name }, { status: 201 });
}
