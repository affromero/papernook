import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { readChat } from "./chats";
import { assertSlug, isValidSlug } from "./slug";
import { companionDir, getPaper, listPapers } from "./papers";

/**
 * Revocable view-only shares live beside the paper they expose:
 *   data/library/<topic>/<slug>/shares/<share-id>.json
 *
 * The annotated PDF remains live, while conversations are snapshotted when
 * the link is created so later private turns never appear without consent.
 */

const SHARE_ID_RE = /^[a-f0-9]{64}$/;
const CHAT_ID_RE = /^[a-f0-9]{16}$/;
const CROP_NAME_RE =
  /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}\.(png|jpg|jpeg|webp|gif)$/;
const MAX_SHARE_BYTES = 20 * 1024 * 1024;
const MAX_CONVERSATIONS = 20;

const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  images: z.array(z.string()).optional(),
  at: z.string(),
});

const sharedConversationSchema = z.object({
  header: z.object({
    id: z.string().regex(CHAT_ID_RE),
    title: z.string(),
    username: z.string(),
    createdAt: z.string(),
  }),
  messages: z.array(chatMessageSchema),
});

const shareRecordSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(SHARE_ID_RE),
  topic: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  ownerUsername: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  createdAt: z.string(),
  conversations: z.array(sharedConversationSchema).max(MAX_CONVERSATIONS),
});

export type PaperShare = z.infer<typeof shareRecordSchema>;
export type SharedConversation = z.infer<typeof sharedConversationSchema>;

export class ShareError extends Error {}

function isShareId(value: string): boolean {
  return SHARE_ID_RE.test(value);
}

function sharesDir(topic: string, slug: string): string {
  assertSlug(topic);
  assertSlug(slug);
  return path.join(companionDir(topic, slug), "shares");
}

function sharePath(topic: string, slug: string, shareId: string): string {
  if (!isShareId(shareId)) throw new ShareError("Invalid share id.");
  return path.join(sharesDir(topic, slug), `${shareId}.json`);
}

function parseShareFile(file: string): PaperShare | null {
  try {
    if (fs.statSync(file).size > MAX_SHARE_BYTES) return null;
    const parsed = shareRecordSchema.safeParse(
      JSON.parse(fs.readFileSync(file, "utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function readStoredShare(
  topic: string,
  slug: string,
  shareId: string,
): PaperShare | null {
  if (!isValidSlug(topic) || !isValidSlug(slug) || !isShareId(shareId)) {
    return null;
  }
  const share = parseShareFile(sharePath(topic, slug, shareId));
  if (
    !share ||
    share.id !== shareId ||
    share.topic !== topic ||
    share.slug !== slug
  ) {
    return null;
  }
  return share;
}

/** Resolve a public link only while its confirmed paper still exists. */
export function getShare(
  topic: string,
  slug: string,
  shareId: string,
): PaperShare | null {
  const share = readStoredShare(topic, slug, shareId);
  return share && getPaper(topic, slug) ? share : null;
}

export function createShare(
  topic: string,
  slug: string,
  ownerUsername: string,
  chatIds: string[],
): PaperShare {
  assertSlug(topic);
  assertSlug(slug);
  assertSlug(ownerUsername);
  if (!getPaper(topic, slug)) throw new ShareError("Unknown paper.");

  const uniqueChatIds = [...new Set(chatIds)];
  if (
    uniqueChatIds.length > MAX_CONVERSATIONS ||
    uniqueChatIds.some((id) => !CHAT_ID_RE.test(id))
  ) {
    throw new ShareError("Invalid conversations.");
  }

  const conversations = uniqueChatIds.map((chatId) => {
    const chat = readChat(topic, slug, ownerUsername, chatId);
    if (!chat) throw new ShareError("Unknown conversation.");
    return chat;
  });

  const id = crypto.randomBytes(32).toString("hex");
  const share: PaperShare = {
    version: 1,
    id,
    topic,
    slug,
    ownerUsername,
    createdAt: new Date().toISOString(),
    conversations,
  };

  const dir = sharesDir(topic, slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = sharePath(topic, slug, id);
  const tmp = path.join(dir, `.${id}.${process.pid}.tmp`);
  const serialized = JSON.stringify(share, null, 2);
  if (Buffer.byteLength(serialized, "utf8") > MAX_SHARE_BYTES) {
    throw new ShareError("Selected conversations are too large to share.");
  }
  try {
    fs.writeFileSync(tmp, serialized, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  return share;
}

export function listShares(
  topic: string,
  slug: string,
  ownerUsername: string,
): PaperShare[] {
  if (
    !isValidSlug(topic) ||
    !isValidSlug(slug) ||
    !isValidSlug(ownerUsername)
  ) {
    return [];
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sharesDir(topic, slug), {
      withFileTypes: true,
    });
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name),
    )
    .map((entry) =>
      readStoredShare(topic, slug, entry.name.replace(/\.json$/, "")),
    )
    .filter(
      (share): share is PaperShare =>
        share !== null && share.ownerUsername === ownerUsername,
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function deleteShare(
  topic: string,
  slug: string,
  shareId: string,
  ownerUsername: string,
): boolean {
  const share = readStoredShare(topic, slug, shareId);
  if (!share || share.ownerUsername !== ownerUsername) return false;
  try {
    fs.unlinkSync(sharePath(topic, slug, shareId));
    return true;
  } catch {
    return false;
  }
}

/** Profile deletion must revoke links that otherwise outlive their owner. */
export function deleteSharesByOwner(ownerUsername: string): void {
  if (!isValidSlug(ownerUsername)) return;
  for (const paper of listPapers()) {
    if (!paper.topic) continue;
    for (const share of listShares(paper.topic, paper.slug, ownerUsername)) {
      fs.rmSync(sharePath(paper.topic, paper.slug, share.id), { force: true });
    }
  }
}

export interface SharedCrop {
  filePath: string;
  contentType: string;
}

/** Return only crop files referenced by the snapshotted conversations. */
export function resolveSharedCrop(
  share: PaperShare,
  imageName: string,
): SharedCrop | null {
  if (!CROP_NAME_RE.test(imageName)) return null;
  const relative = `crops/${imageName}`;
  const isReferenced = share.conversations.some((conversation) =>
    conversation.messages.some((message) => message.images?.includes(relative)),
  );
  if (!isReferenced) return null;

  const filePath = path.join(
    companionDir(share.topic, share.slug),
    "crops",
    imageName,
  );
  if (!fs.existsSync(filePath)) return null;
  const ext = path.extname(imageName).toLowerCase();
  const contentType =
    ext === ".png"
      ? "image/png"
      : ext === ".webp"
        ? "image/webp"
        : ext === ".gif"
          ? "image/gif"
          : "image/jpeg";
  return { filePath, contentType };
}
