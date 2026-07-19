import fs from "node:fs";
import { NextResponse, type NextRequest } from "next/server";
import { getPaper } from "@/lib/library/papers";
import { getShare } from "@/lib/library/shares";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ topic: string; slug: string; shareId: string }>;
}

const PRIVATE_HEADERS = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
};

export async function GET(_request: NextRequest, { params }: Params) {
  const { topic, slug, shareId } = await params;
  const share = getShare(topic, slug, shareId);
  const paper = share ? getPaper(topic, slug) : null;
  if (!share || !paper) {
    return NextResponse.json(
      { error: "Unknown share." },
      { status: 404, headers: PRIVATE_HEADERS },
    );
  }
  try {
    const bytes = fs.readFileSync(paper.pdfPath);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        ...PRIVATE_HEADERS,
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${slug}.pdf"`,
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Paper is temporarily unavailable." },
      { status: 503, headers: PRIVATE_HEADERS },
    );
  }
}
