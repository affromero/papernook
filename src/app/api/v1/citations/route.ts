import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { activeProfile } from "@/lib/auth/session";
import {
  CITATION_FORMATS,
  citationContentType,
  citationExtension,
  exportCitations,
} from "@/lib/library/citations";
import { confirmedPapersForFilters } from "@/lib/library/citations/filters";

export const dynamic = "force-dynamic";

const topicSchema = z.union([
  z.literal("_inbox"),
  z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
]);
const querySchema = z.object({
  format: z.enum(CITATION_FORMATS).default("csl-json"),
  q: z.string().max(500).default(""),
  tag: z.string().min(1).max(500).nullable().default(null),
  topic: topicSchema.nullable().default(null),
});

export async function GET(request: NextRequest) {
  const profile = await activeProfile();
  if (!profile)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const params = request.nextUrl.searchParams;
  const query = querySchema.safeParse({
    format: params.get("format") ?? undefined,
    q: params.get("q") ?? undefined,
    tag: params.get("tag"),
    topic: params.get("topic"),
  });
  if (!query.success) {
    return NextResponse.json(
      { error: "Invalid citation export filters." },
      { status: 400 },
    );
  }
  if (query.data.topic === "_inbox") {
    return NextResponse.json(
      { error: "Pending captures cannot be exported." },
      { status: 400 },
    );
  }

  const papers = confirmedPapersForFilters({
    query: query.data.q,
    tag: query.data.tag,
    topic: query.data.topic,
  });
  const body = exportCitations(papers, query.data.format);
  return new NextResponse(body, {
    headers: {
      "content-type": `${citationContentType(query.data.format)}; charset=utf-8`,
      "content-disposition": `attachment; filename="papernook-library.${citationExtension(query.data.format)}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
