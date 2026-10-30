import { NextResponse, type NextRequest } from "next/server";
import { activeProfile } from "@/lib/auth/session";
import { getPaper } from "@/lib/library/papers";
import { readCanvasAsset, removeCanvasAsset } from "@/lib/canvas/assets";
import {
  connectedCanvasAsset,
  deleteConnectedCanvasAsset,
} from "@/lib/sharing/artifacts/gateway";
import { sharingFailure } from "@/lib/sharing/schema";

export const dynamic = "force-dynamic";
interface Params {
  params: Promise<{ topic: string; slug: string; asset: string }>;
}
export async function GET(_request: NextRequest, { params }: Params) {
  if (!(await activeProfile()))
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { topic, slug, asset } = await params;
  try {
    const paper = getPaper(topic, slug);
    if (!paper)
      return NextResponse.json({ error: "Unknown asset." }, { status: 404 });
    const value =
      (await connectedCanvasAsset(topic, slug, asset)) ??
      readCanvasAsset(paper.companionDir, asset);
    return new NextResponse(Buffer.from(value.bytes), {
      headers: {
        "content-type": value.mime,
        "cache-control": "private, no-store",
        "content-security-policy": "default-src 'none'; sandbox",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return NextResponse.json({ error: "Unknown asset." }, { status: 404 });
    return sharingFailure(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  if (!(await activeProfile()))
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { topic, slug, asset } = await params;
  try {
    const connected = await deleteConnectedCanvasAsset(topic, slug, asset);
    if (!connected) removeCanvasAsset(topic, slug, asset);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return sharingFailure(error);
  }
}
