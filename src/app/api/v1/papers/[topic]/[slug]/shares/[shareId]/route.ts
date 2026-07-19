import { NextResponse, type NextRequest } from "next/server";
import { activeProfile } from "@/lib/auth/session";
import { deleteShare } from "@/lib/library/shares";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ topic: string; slug: string; shareId: string }>;
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const profile = await activeProfile();
  if (!profile) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const { topic, slug, shareId } = await params;
  if (!deleteShare(topic, slug, shareId, profile.username)) {
    return NextResponse.json({ error: "Unknown share." }, { status: 404 });
  }
  return new NextResponse(null, { status: 204 });
}
