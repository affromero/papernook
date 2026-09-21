import { NextResponse, type NextRequest } from "next/server";
import {
  requestIdentity,
  sharedAccess,
  accessFailure,
} from "@/lib/auth/access";
import { withProfileFiles } from "@/lib/auth/profile-capability";
import { deleteShare } from "@/lib/library/shares";

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
