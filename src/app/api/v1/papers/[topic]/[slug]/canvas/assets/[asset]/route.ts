import fs from "node:fs";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { activeProfile } from "@/lib/auth/session";
import { getPaper } from "@/lib/library/papers";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ topic: string; slug: string; asset: string }>;
}

const assetName = z
  .string()
  .regex(/^(?:[0-9a-f]{64}|[0-9a-f-]{36})\.(gif|jpe?g|mov|mp4|png|webm|webp)$/);

export async function GET(_request: NextRequest, { params }: Params) {
  const profile = await activeProfile();
  if (!profile)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { topic, slug, asset } = await params;
  const parsedAsset = assetName.safeParse(asset);
  const paper = getPaper(topic, slug);
  if (!paper || !parsedAsset.success)
    return NextResponse.json({ error: "Unknown asset." }, { status: 404 });
  const file = path.join(paper.companionDir, "canvas-assets", parsedAsset.data);
  try {
    const body = fs.readFileSync(file);
    const extension = path.extname(file).slice(1);
    const contentType =
      {
        gif: "image/gif",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        mov: "video/quicktime",
        mp4: "video/mp4",
        png: "image/png",
        webm: "video/webm",
        webp: "image/webp",
      }[extension] ?? "application/octet-stream";
    return new NextResponse(body, {
      headers: {
        "content-type": contentType,
        "cache-control": "private, max-age=31536000, immutable",
        "content-security-policy": "default-src 'none'; sandbox",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "Unknown asset." }, { status: 404 });
  }
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const profile = await activeProfile();
  if (!profile)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { topic, slug, asset } = await params;
  const parsedAsset = assetName.safeParse(asset);
  const paper = getPaper(topic, slug);
  if (!paper || !parsedAsset.success)
    return NextResponse.json({ error: "Unknown asset." }, { status: 404 });
  const file = path.join(paper.companionDir, "canvas-assets", parsedAsset.data);
  try {
    fs.unlinkSync(file);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return new NextResponse(null, { status: 204 });
    }
    throw error;
  }
}
