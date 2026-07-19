import fs from "node:fs";
import { NextResponse, type NextRequest } from "next/server";
import { getShare, resolveSharedCrop } from "@/lib/library/shares";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{
    topic: string;
    slug: string;
    shareId: string;
    imageName: string;
  }>;
}

const PRIVATE_HEADERS = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
};

export async function GET(_request: NextRequest, { params }: Params) {
  const { topic, slug, shareId, imageName } = await params;
  const share = getShare(topic, slug, shareId);
  const crop = share ? resolveSharedCrop(share, imageName) : null;
  if (!crop) {
    return NextResponse.json(
      { error: "Unknown image." },
      { status: 404, headers: PRIVATE_HEADERS },
    );
  }
  try {
    const bytes = fs.readFileSync(crop.filePath);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        ...PRIVATE_HEADERS,
        "content-type": crop.contentType,
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Image is temporarily unavailable." },
      { status: 503, headers: PRIVATE_HEADERS },
    );
  }
}
