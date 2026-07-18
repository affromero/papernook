import { NextResponse, type NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { activeProfile } from "@/lib/auth/session";
import { getPaper } from "@/lib/library/papers";
import { readChat, appendMessage } from "@/lib/library/chats";
import { buildChatSystem, buildChatPrompt } from "@/lib/library/chat-context";
import { getProvider } from "@/lib/agent/registry";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ topic: string; slug: string; chatId: string }>;
}

export async function GET(_req: NextRequest, { params }: Params) {
  const profile = await activeProfile();
  if (!profile)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { topic, slug, chatId } = await params;
  const chat = readChat(topic, slug, profile.username, chatId);
  if (!chat)
    return NextResponse.json({ error: "Unknown chat." }, { status: 404 });
  return NextResponse.json({ chat });
}

const messageSchema = z.object({
  content: z.string().min(1).max(20_000),
  /** Base64 data-URL images pasted into the input (screenshots, crops). */
  images: z.array(z.string().startsWith("data:image/")).max(4).optional(),
});

/** Persist pasted data-URL images into crops/ and return absolute paths. */
function persistImages(
  companion: string,
  dataUrls: string[],
): { absolute: string[]; relative: string[] } {
  const cropsDir = path.join(companion, "crops");
  fs.mkdirSync(cropsDir, { recursive: true });
  const absolute: string[] = [];
  const relative: string[] = [];
  for (const dataUrl of dataUrls) {
    const match = dataUrl.match(
      /^data:image\/(png|jpeg|webp|gif);base64,(.+)$/,
    );
    if (!match) continue;
    const ext = match[1] === "jpeg" ? "jpg" : match[1];
    const name = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
    const filePath = path.join(cropsDir, name);
    fs.writeFileSync(filePath, Buffer.from(match[2], "base64"));
    absolute.push(filePath);
    relative.push(`crops/${name}`);
  }
  return { absolute, relative };
}

/**
 * Send a message: appends the user turn, streams the assistant reply as
 * plain text chunks, and appends the full reply once the stream ends.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const profile = await activeProfile();
  if (!profile)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { topic, slug, chatId } = await params;
  const paper = getPaper(topic, slug);
  const chat = paper ? readChat(topic, slug, profile.username, chatId) : null;
  if (!paper || !chat) {
    return NextResponse.json({ error: "Unknown chat." }, { status: 404 });
  }
  const body = messageSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: "Invalid message." }, { status: 400 });
  }

  const images = persistImages(paper.companionDir, body.data.images ?? []);
  appendMessage(topic, slug, profile.username, chatId, {
    role: "user",
    content: body.data.content,
    images: images.relative.length ? images.relative : undefined,
    at: new Date().toISOString(),
  });

  const system = buildChatSystem(paper);
  const prompt = buildChatPrompt(chat.messages, body.data.content);
  const provider = getProvider();

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let full = "";
      try {
        for await (const chunk of provider.stream({
          system,
          prompt,
          images: images.absolute.length ? images.absolute : undefined,
        })) {
          full += chunk;
          controller.enqueue(encoder.encode(chunk));
        }
        appendMessage(topic, slug, profile.username, chatId, {
          role: "assistant",
          content: full,
          at: new Date().toISOString(),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Agent failed.";
        controller.enqueue(encoder.encode(`\n\n[error: ${message}]`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
}
