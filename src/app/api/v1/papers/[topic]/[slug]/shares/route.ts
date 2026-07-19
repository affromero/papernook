import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { activeProfile } from "@/lib/auth/session";
import { getPaper } from "@/lib/library/papers";
import {
  createShare,
  listShares,
  ShareError,
  type PaperShare,
} from "@/lib/library/shares";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ topic: string; slug: string }>;
}

const createSchema = z.object({
  chatIds: z.array(z.string().regex(/^[a-f0-9]{16}$/)).max(20),
});

function toPublicSummary(share: PaperShare) {
  return {
    id: share.id,
    href: `/share/${share.topic}/${share.slug}/${share.id}`,
    createdAt: share.createdAt,
    conversations: share.conversations.map((conversation) => ({
      id: conversation.header.id,
      title: conversation.header.title,
    })),
  };
}

export async function GET(_request: NextRequest, { params }: Params) {
  const profile = await activeProfile();
  if (!profile) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const { topic, slug } = await params;
  if (!getPaper(topic, slug)) {
    return NextResponse.json({ error: "Unknown paper." }, { status: 404 });
  }
  return NextResponse.json({
    shares: listShares(topic, slug, profile.username).map(toPublicSummary),
  });
}

export async function POST(request: NextRequest, { params }: Params) {
  const profile = await activeProfile();
  if (!profile) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const { topic, slug } = await params;
  if (!getPaper(topic, slug)) {
    return NextResponse.json({ error: "Unknown paper." }, { status: 404 });
  }
  const body = createSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json(
      { error: "Invalid conversations." },
      { status: 400 },
    );
  }
  try {
    const share = createShare(topic, slug, profile.username, body.data.chatIds);
    return NextResponse.json(
      { share: toPublicSummary(share) },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof ShareError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
