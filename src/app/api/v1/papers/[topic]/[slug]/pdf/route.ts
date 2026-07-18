import { NextResponse, type NextRequest } from "next/server";
import fs from "node:fs";
import { activeProfile } from "@/lib/auth/session";
import { getPaper } from "@/lib/library/papers";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ topic: string; slug: string }>;
}

export async function GET(_req: NextRequest, { params }: Params) {
  const profile = await activeProfile();
  if (!profile)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { topic, slug } = await params;
  const paper = getPaper(topic, slug);
  if (!paper)
    return NextResponse.json({ error: "Unknown paper." }, { status: 404 });
  const bytes = fs.readFileSync(paper.pdfPath);
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${slug}.pdf"`,
      "cache-control": "no-cache",
    },
  });
}
