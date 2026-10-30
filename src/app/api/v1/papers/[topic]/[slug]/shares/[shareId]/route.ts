import { NextResponse, type NextRequest } from "next/server";
import {
  requestIdentity,
  sharedAccess,
  accessFailure,
} from "@/lib/auth/access";
import { withProfileFiles } from "@/lib/auth/profile-capability";
import { deleteShare, getShare } from "@/lib/library/shares";
import { withCollaboration } from "@/lib/sharing/storage";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ topic: string; slug: string; shareId: string }>;
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const admission = await requestIdentity();
  const profile = admission?.profile;
  const capability = admission?.capability;
  if (!profile || !capability) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const { topic, slug, shareId } = await params;
  try {
    const share = getShare(topic, slug, shareId);
    if (
      share?.mode === "collaborate" &&
      share.ownerUsername === profile.username &&
      share.ownerGeneration === capability.generation
    ) {
      return await withCollaboration(share, async () => {
        if (!deleteShare(topic, slug, shareId, profile.username))
          return NextResponse.json(
            { error: "Unknown share." },
            { status: 404 },
          );
        return new NextResponse(null, { status: 204 });
      });
    }
    return withProfileFiles(sharedAccess().identity, capability, () => {
      if (!deleteShare(topic, slug, shareId, profile.username)) {
        return NextResponse.json({ error: "Unknown share." }, { status: 404 });
      }
      return new NextResponse(null, { status: 204 });
    });
  } catch (error) {
    return accessFailure(error);
  }
}
