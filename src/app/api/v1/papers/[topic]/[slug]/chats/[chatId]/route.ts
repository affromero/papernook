import { NextResponse, type NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { activeProfile } from "@/lib/auth/session";
import { getPaper } from "@/lib/library/papers";
import { readChat, appendMessage, deleteMessage } from "@/lib/library/chats";
import { buildChatSystem, buildChatPrompt } from "@/lib/library/chat-context";
import { getProvider, hasConfiguredProvider } from "@/lib/agent/registry";
import { webAccessEnabled } from "@/lib/agent/config";
import { readBoundedJson, RequestBodyError } from "@/lib/bounded-request";

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

const deleteSchema = z.object({
  index: z.number().int().min(0).max(100_000),
  at: z.string().min(1).max(64),
});

/** Delete one message from the caller's own chat, matched by index + at. */
export async function DELETE(request: NextRequest, { params }: Params) {
  const profile = await activeProfile();
  if (!profile)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { topic, slug, chatId } = await params;
  let raw: unknown;
  try {
    raw = await readBoundedJson(request, 4096);
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }
    throw error;
  }
  const body = deleteSchema.safeParse(raw);
  if (!body.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const removed = deleteMessage(
    topic,
    slug,
    profile.username,
    chatId,
    body.data.index,
    body.data.at,
  );
  if (!removed) {
    // Missing chat and stale index/timestamp look the same on purpose:
    // the client's view is outdated either way — reload the chat.
    return NextResponse.json({ error: "Message not found." }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_MESSAGE_BODY_BYTES = 15 * 1024 * 1024;
const MAX_DATA_URL_CHARS = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 64;

const messageSchema = z.object({
  content: z.string().min(1).max(20_000),
  /** Base64 data-URL images pasted into the input (screenshots, crops). */
  images: z
    .array(z.string().startsWith("data:image/").max(MAX_DATA_URL_CHARS))
    .max(4)
    .optional(),
});

function hasExpectedSignature(type: string, value: Buffer): boolean {
  if (type === "png")
    return value.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  if (type === "jpeg")
    return value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff;
  if (type === "gif")
    return ["GIF87a", "GIF89a"].includes(
      value.subarray(0, 6).toString("ascii"),
    );
  if (type === "webp")
    return (
      value.subarray(0, 4).toString("ascii") === "RIFF" &&
      value.subarray(8, 12).toString("ascii") === "WEBP"
    );
  return false;
}

/** Persist pasted data-URL images into crops/ and return absolute paths. */
function persistImages(
  companion: string,
  dataUrls: string[],
): { absolute: string[]; relative: string[] } {
  const decoded: { type: string; bytes: Buffer }[] = [];
  let totalBytes = 0;
  for (const dataUrl of dataUrls) {
    const match = dataUrl.match(
      /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/,
    );
    if (!match || match[2].length % 4 !== 0) {
      throw new RequestBodyError("Invalid image attachment.", 400);
    }
    const bytes = Buffer.from(match[2], "base64");
    totalBytes += bytes.length;
    if (
      bytes.length === 0 ||
      bytes.length > MAX_IMAGE_BYTES ||
      totalBytes > MAX_TOTAL_IMAGE_BYTES ||
      !hasExpectedSignature(match[1], bytes)
    ) {
      throw new RequestBodyError("Invalid image attachment.", 400);
    }
    decoded.push({ type: match[1], bytes });
  }

  const cropsDir = path.join(companion, "crops");
  fs.mkdirSync(cropsDir, { recursive: true, mode: 0o700 });
  const absolute: string[] = [];
  const relative: string[] = [];
  try {
    for (const image of decoded) {
      const ext = image.type === "jpeg" ? "jpg" : image.type;
      const name = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
      const filePath = path.join(cropsDir, name);
      fs.writeFileSync(filePath, image.bytes, { mode: 0o600 });
      absolute.push(filePath);
      relative.push(`crops/${name}`);
    }
  } catch (error) {
    for (const file of absolute) fs.rmSync(file, { force: true });
    throw error;
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
  if (!hasConfiguredProvider()) {
    return NextResponse.json(
      { error: "No AI provider configured. Connect one in Settings." },
      { status: 409 },
    );
  }
  let raw: unknown;
  try {
    raw = await readBoundedJson(request, MAX_MESSAGE_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }
    throw error;
  }
  const body = messageSchema.safeParse(raw);
  if (!body.success) {
    return NextResponse.json({ error: "Invalid message." }, { status: 400 });
  }

  // capabilities is optional-chained so registry mocks without it stay
  // conservative: no declared capabilities means no vision and no web.
  const provider = getProvider();
  if (body.data.images?.length && !provider.capabilities?.vision) {
    return NextResponse.json(
      { error: "The configured AI provider can't read images." },
      { status: 400 },
    );
  }

  let images: ReturnType<typeof persistImages>;
  try {
    images = persistImages(paper.companionDir, body.data.images ?? []);
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }
    throw error;
  }
  appendMessage(topic, slug, profile.username, chatId, {
    role: "user",
    content: body.data.content,
    images: images.relative.length ? images.relative : undefined,
    at: new Date().toISOString(),
  });

  const allowWeb = webAccessEnabled() && Boolean(provider.capabilities?.web);
  const system = await buildChatSystem(
    paper,
    profile.username,
    body.data.content,
    allowWeb,
  );
  const prompt = buildChatPrompt(chat.messages, body.data.content);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let full = "";
      try {
        for await (const chunk of provider.stream({
          system,
          prompt,
          images: images.absolute.length ? images.absolute : undefined,
          allowWeb,
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
