import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isValidSlug } from "@/lib/library/slug";
import {
  requestIdentity,
  sharedAccess,
  accessFailure,
} from "@/lib/auth/access";
import { withProfileFiles } from "@/lib/auth/profile-capability";
import { consumeRequestLimit } from "@/lib/auth/rate-limit";
import { readBoundedJsonOrNull } from "@/lib/bounded-request";
import {
  readPosition,
  readingPositionSchema,
  writePosition,
} from "@/lib/library/positions/store";
import { getPaper } from "@/lib/library/papers";

export const dynamic = "force-dynamic";

/**
 * The active profile's reading position for a paper, so a paper opened on
 * one device resumes where another left it. The reader PUTs on every
 * debounced page/zoom move and GETs once per document open; positions are
 * per profile — no one can read or move another reader's spot.
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
  const admission = await requestIdentity();
  const profile = admission?.profile;
  const capability = admission?.capability;
  if (!profile || !capability)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const routeParams = paramsSchema.safeParse(await params);
  if (!routeParams.success) {
    return NextResponse.json({ error: "Invalid paper." }, { status: 400 });
  }
  const { topic, slug } = routeParams.data;
  if (!getPaper(topic, slug))
    return NextResponse.json({ error: "Unknown paper." }, { status: 404 });
  try {
    return withProfileFiles(sharedAccess().identity, capability, () =>
      NextResponse.json(
        {
          position: readPosition(topic, slug, profile.username),
        },
        { headers: { "Cache-Control": "no-store" } },
      ),
    );
  } catch (error) {
    return accessFailure(error);
  }
}

export async function PUT(request: NextRequest, { params }: Params) {
  const admission = await requestIdentity();
  const profile = admission?.profile;
  const capability = admission?.capability;
  if (!profile || !capability)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const routeParams = paramsSchema.safeParse(await params);
  if (!routeParams.success) {
    return NextResponse.json({ error: "Invalid paper." }, { status: 400 });
  }
  const { topic, slug } = routeParams.data;
  if (!getPaper(topic, slug))
    return NextResponse.json({ error: "Unknown paper." }, { status: 404 });
  const wait = consumeRequestLimit(
    `position:${profile.username}`,
    120,
    10 * 60_000,
  );
  if (wait > 0) {
    return NextResponse.json({ error: "Too many writes." }, { status: 429 });
  }
  const body = readingPositionSchema.safeParse(
    await readBoundedJsonOrNull(request, 4096),
  );
  if (!body.success) {
    return NextResponse.json({ error: "Invalid position." }, { status: 400 });
  }
  try {
    return withProfileFiles(sharedAccess().identity, capability, () => {
      writePosition(topic, slug, profile.username, body.data);
      return NextResponse.json({ ok: true });
    });
  } catch (error) {
    return accessFailure(error);
  }
}
