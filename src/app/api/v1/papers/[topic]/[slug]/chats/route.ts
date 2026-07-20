import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { activeProfile } from "@/lib/auth/session";
import { getPaper } from "@/lib/library/papers";
import { listChats, createChat } from "@/lib/library/chats";
import { readBoundedJsonOrNull } from "@/lib/bounded-request";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ topic: string; slug: string }>;
}

export async function GET(_req: NextRequest, { params }: Params) {
  const profile = await activeProfile();
  if (!profile)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { topic, slug } = await params;
  if (!getPaper(topic, slug)) {
    return NextResponse.json({ error: "Unknown paper." }, { status: 404 });
  }
  return NextResponse.json({ chats: listChats(topic, slug, profile.username) });
}

const createSchema = z.object({ title: z.string().min(1).max(120) });

export async function POST(request: NextRequest, { params }: Params) {
  const profile = await activeProfile();
  if (!profile)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { topic, slug } = await params;
  if (!getPaper(topic, slug)) {
    return NextResponse.json({ error: "Unknown paper." }, { status: 404 });
  }
  const body = createSchema.safeParse(await readBoundedJsonOrNull(request));
  if (!body.success) {
    return NextResponse.json({ error: "Invalid title." }, { status: 400 });
  }
  const header = createChat(topic, slug, profile.username, body.data.title);
  return NextResponse.json({ chat: header }, { status: 201 });
}
