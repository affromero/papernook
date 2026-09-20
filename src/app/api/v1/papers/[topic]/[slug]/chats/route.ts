import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  requestIdentity,
  sharedAccess,
  accessFailure,
} from "@/lib/auth/access";
import { withProfileFiles } from "@/lib/auth/profile-capability";
import { getPaper } from "@/lib/library/papers";
import { listChats, createChat, NEW_CHAT_TITLE } from "@/lib/library/chats";
import { readBoundedJsonOrNull } from "@/lib/bounded-request";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ topic: string; slug: string }>;
}

export async function GET(_req: NextRequest, { params }: Params) {
  const admission = await requestIdentity();
  const profile = admission?.profile;
  const capability = admission?.capability;
  if (!profile || !capability)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { topic, slug } = await params;
  if (!getPaper(topic, slug)) {
    return NextResponse.json({ error: "Unknown paper." }, { status: 404 });
  }
  try {
    return withProfileFiles(sharedAccess().identity, capability, () =>
      NextResponse.json(
        { chats: listChats(topic, slug, profile.username) },
        { headers: { "Cache-Control": "no-store" } },
      ),
    );
  } catch (error) {
    return accessFailure(error);
  }
}

const createSchema = z.object({}).strict();

export async function POST(request: NextRequest, { params }: Params) {
  const admission = await requestIdentity();
  const profile = admission?.profile;
  const capability = admission?.capability;
  if (!profile || !capability)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { topic, slug } = await params;
  if (!getPaper(topic, slug)) {
    return NextResponse.json({ error: "Unknown paper." }, { status: 404 });
  }
  const body = createSchema.safeParse(await readBoundedJsonOrNull(request));
  if (!body.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    return withProfileFiles(sharedAccess().identity, capability, () => {
      const header = createChat(topic, slug, profile.username, NEW_CHAT_TITLE);
      return NextResponse.json({ chat: header }, { status: 201 });
    });
  } catch (error) {
    return accessFailure(error);
  }
}
