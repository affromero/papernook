import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { activeProfile } from "@/lib/auth/session";
import {
  CITATION_FORMATS,
  citationContentType,
  citationExtension,
  exportCitations,
} from "@/lib/library/citations";
import { getPaper } from "@/lib/library/papers";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  format: z.enum(CITATION_FORMATS).default("csl-json"),
});
const paramsSchema = z.object({
  topic: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
});

interface Params {
  params: Promise<{ topic: string; slug: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  const profile = await activeProfile();
  if (!profile)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const query = querySchema.safeParse({
    format: request.nextUrl.searchParams.get("format") ?? undefined,
  });
  if (!query.success) {
    return NextResponse.json(
      { error: "Unsupported citation format." },
      { status: 400 },
    );
  }
  const routeParams = paramsSchema.safeParse(await params);
  if (!routeParams.success) {
    return NextResponse.json({ error: "Invalid paper." }, { status: 400 });
  }
  const paper = getPaper(routeParams.data.topic, routeParams.data.slug);
  if (!paper)
    return NextResponse.json({ error: "Unknown paper." }, { status: 404 });

  const body = exportCitations([paper], query.data.format);
  return new NextResponse(body, {
    headers: {
      "content-type": `${citationContentType(query.data.format)}; charset=utf-8`,
      "content-disposition": `attachment; filename="${routeParams.data.slug}.${citationExtension(query.data.format)}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
