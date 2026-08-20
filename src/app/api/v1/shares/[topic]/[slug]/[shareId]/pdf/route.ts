import { NextResponse, type NextRequest } from "next/server";
import { fileResponse } from "@/lib/http/file-range";
import { getPaper } from "@/lib/library/papers";
import { readVersionedPdfFile } from "@/lib/library/pdf/file";
import { getShare } from "@/lib/library/shares";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ topic: string; slug: string; shareId: string }>;
}

const PRIVATE_CACHE_CONTROL = "private, no-cache";

const PRIVATE_HEADERS = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
};

export async function GET(request: NextRequest, { params }: Params) {
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
    const pdf = await readVersionedPdfFile(topic, slug);
    if (!pdf) throw new Error("The shared PDF is missing.");
    return fileResponse({
      path: pdf.path,
      size: pdf.size,
      etag: pdf.etag,
      headers: request.headers,
      contentType: "application/pdf",
      filename: `${slug}.pdf`,
      cacheControl: PRIVATE_CACHE_CONTROL,
      extraHeaders: PRIVATE_HEADERS,
    });
  } catch {
    return NextResponse.json(
      { error: "Paper is temporarily unavailable." },
      { status: 503, headers: PRIVATE_HEADERS },
    );
  }
}
