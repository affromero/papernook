import { NextResponse, type NextRequest } from "next/server";
import { activeProfile } from "@/lib/auth/session";
import { readBoundedBytes, RequestBodyError } from "@/lib/bounded-request";
import { storeCanvasAsset } from "@/lib/canvas/assets";
import { MAX_CANVAS_ASSET_BYTES } from "@/lib/canvas/media";
import { uploadConnectedCanvasAsset } from "@/lib/sharing/artifacts/gateway";
import {
  hasCollaboration,
  localArtifactAuthority,
} from "@/lib/sharing/artifacts/local";
import { uploadSourceAsset } from "@/lib/sharing/artifacts/source";
import { sharingFailure } from "@/lib/sharing/schema";

export const dynamic = "force-dynamic";
interface Params {
  params: Promise<{ topic: string; slug: string }>;
}
export async function POST(request: NextRequest, { params }: Params) {
  const profile = await activeProfile();
  if (!profile)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { topic, slug } = await params;
  try {
    const mime = request.headers.get("content-type")?.split(";")[0] ?? "";
    const bytes = await readBoundedBytes(
      request,
      MAX_CANVAS_ASSET_BYTES,
      AbortSignal.timeout(30_000),
    );
    const connected = await uploadConnectedCanvasAsset(
      topic,
      slug,
      bytes,
      mime,
    );
    if (connected) return NextResponse.json(connected);
    let name: string;
    if (hasCollaboration(topic, slug)) {
      const authority = await localArtifactAuthority();
      name = uploadSourceAsset(
        topic,
        slug,
        bytes,
        mime,
        authority.actor,
        authority.commit,
      );
    } else
      name = storeCanvasAsset(
        topic,
        slug,
        bytes,
        mime,
        `profile:${profile.username}`,
      );
    return NextResponse.json({
      src: `/api/v1/papers/${topic}/${slug}/canvas/assets/${name}`,
    });
  } catch (error) {
    if (error instanceof RequestBodyError && error.status === 413)
      return NextResponse.json(
        { error: "Canvas assets must be between 1 byte and 50 MB." },
        { status: 413 },
      );
    return sharingFailure(error);
  }
}
