import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { syncDirectory, acquireFileLockSync } from "thesidedoor-core/storage";
import { AccessError, isAccessError } from "thesidedoor-core/access";
import { dataRoot } from "../data-dir";
import { PapernookIdentityStore } from "../auth/identity-store";
import {
  withProfileFiles,
  type ProfileCapability,
} from "../auth/profile-capability";
import { readChat } from "./chats";
import {
  publishOwnerSnapshot,
  unpublishThread,
  synchronizeOwnerThreads,
} from "../sharing/threads";
import {
  ownerActorId,
  ensureCollaborationOwner,
  writeJson,
} from "../sharing/storage";
import { assertSlug, isValidSlug } from "./slug";
import {
  companionDir,
  getPaper,
  visitPaperCompanions,
  withPaperMutation,
} from "./papers";

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
    titleSource: z.enum(["placeholder", "generated", "manual"]).optional(),
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
  ownerGeneration: z.number().int().nonnegative().optional(),
  createdAt: z.string(),
  conversations: z.array(sharedConversationSchema).max(MAX_CONVERSATIONS),
  mode: z.enum(["view", "fork", "collaborate"]).default("view"),
  revoked: z.boolean().default(false),
});

export type PaperShare = z.infer<typeof shareRecordSchema>;

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

function isRevokedShare(share: PaperShare): boolean {
  return (
    share.revoked ||
    fs.existsSync(
      path.join(sharesDir(share.topic, share.slug), `${share.id}.revoked`),
    )
  );
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

/** Revalidate both the owner generation and the original share before private I/O. */
export function withShareFiles<Result>(
  share: PaperShare,
  operation: () => Result &
    (Result extends PromiseLike<unknown> ? never : unknown),
): Result {
  if (share.ownerGeneration === undefined)
    throw new AccessError("unauthorized", "Unknown share.");
  const identity = new PapernookIdentityStore(dataRoot());
  return withProfileFiles(
    identity,
    { username: share.ownerUsername, generation: share.ownerGeneration },
    () => {
      const current = readStoredShare(share.topic, share.slug, share.id);
      if (
        !current ||
        isRevokedShare(current) ||
        current.ownerUsername !== share.ownerUsername ||
        current.ownerGeneration !== share.ownerGeneration
      )
        throw new AccessError("unauthorized", "Unknown share.");
      return operation();
    },
  );
}

/** Resolve a public link only while its confirmed paper still exists. */
export function getShare(
  topic: string,
  slug: string,
  shareId: string,
): PaperShare | null {
  const share = readStoredShare(topic, slug, shareId);
  if (!share || isRevokedShare(share) || share.ownerGeneration === undefined)
    return null;
  try {
    return withShareFiles(share, () => (getPaper(topic, slug) ? share : null));
  } catch (error) {
    if (isAccessError(error) && error.code === "unauthorized") return null;
    throw error;
  }
}

export function createShare(
  topic: string,
  slug: string,
  capability: ProfileCapability,
  chatIds: string[],
  mode: PaperShare["mode"] = "view",
): PaperShare {
  const ownerUsername = capability.username;
  return withProfileFiles(
    new PapernookIdentityStore(dataRoot()),
    capability,
    () => {
      assertSlug(topic);
      assertSlug(slug);
      assertSlug(ownerUsername);
      const paper = getPaper(topic, slug);
      if (!paper) throw new ShareError("Unknown paper.");
      if (
        mode === "collaborate" &&
        fs.statSync(paper.pdfPath).size > 32 * 1024 * 1024
      )
        throw new ShareError(
          "Collaborative annotation saves support PDFs up to 32 MB. Use an independent fork for larger papers.",
        );

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
        ownerGeneration: capability.generation,
        createdAt: new Date().toISOString(),
        conversations,
        mode,
        revoked: false,
      };
      if (mode !== "collaborate") return persistShare(share);
      const release = acquireFileLockSync(
        path.join(dataRoot(), "locks", "collaboration", `${id}.guard`),
      );
      try {
        persistShare(share);
        ensureCollaborationOwner(share);
        try {
          synchronizeOwnerThreads(share);
        } catch (error) {
          deleteShare(topic, slug, id, ownerUsername);
          throw error;
        }
        return share;
      } finally {
        release();
      }
    },
  );
}

function persistShare(share: PaperShare): PaperShare {
  return withPaperMutation(share.slug, () => persistShareLocked(share));
}

function persistShareLocked(share: PaperShare): PaperShare {
  const { topic, slug, id } = share;
  if (!fs.existsSync(companionDir(topic, slug)))
    throw new ShareError(
      "The paper was moved or removed. Reload it before sharing.",
    );
  const dir = sharesDir(topic, slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = sharePath(topic, slug, id);
  const tmp = path.join(dir, `.${id}.${crypto.randomUUID()}.tmp`);
  const serialized = JSON.stringify(share, null, 2);
  if (Buffer.byteLength(serialized, "utf8") > MAX_SHARE_BYTES) {
    throw new ShareError("Selected conversations are too large to share.");
  }
  try {
    fs.writeFileSync(tmp, serialized, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    fs.renameSync(tmp, file);
    const descriptor = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
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
    .map((share) => ({ ...share, revoked: isRevokedShare(share) }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function publishOwnerChat(
  share: PaperShare,
  capability: ProfileCapability,
  chatId: string,
): void {
  withProfileFiles(new PapernookIdentityStore(dataRoot()), capability, () => {
    withShareFiles(share, () => {
      if (
        share.ownerUsername !== capability.username ||
        share.ownerGeneration !== capability.generation ||
        share.mode !== "collaborate"
      )
        throw new ShareError(
          "Only the sharing owner can publish this conversation.",
        );
      const current = readStoredShare(share.topic, share.slug, share.id);
      const chat = readChat(
        share.topic,
        share.slug,
        capability.username,
        chatId,
      );
      if (!current || !chat) throw new ShareError("Unknown conversation.");
      const folder = path.join(
        companionDir(share.topic, share.slug),
        "collaboration",
        share.id,
      );
      const file = path.join(folder, "owner-chats.json");
      const ids = fs.existsSync(file)
        ? z
            .array(z.string().regex(CHAT_ID_RE))
            .max(MAX_CONVERSATIONS)
            .parse(JSON.parse(fs.readFileSync(file, "utf8")))
        : [];
      if (
        current.conversations.some((entry) => entry.header.id === chatId) ||
        ids.includes(chatId)
      )
        return publishOwnerSnapshot(share, chat);
      if (current.conversations.length + ids.length >= MAX_CONVERSATIONS)
        throw new ShareError("The conversation limit has been reached.");
      publishOwnerSnapshot(share, chat);
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      const temp = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temp, JSON.stringify([...ids, chatId]), {
          mode: 0o600,
          flag: "wx",
          flush: true,
        });
        fs.renameSync(temp, file);
        syncDirectory(folder);
      } catch (error) {
        unpublishThread(share, { id: ownerActorId(share) }, chatId);
        throw error;
      } finally {
        fs.rmSync(temp, { force: true });
      }
    });
  });
}

export function deleteShare(
  topic: string,
  slug: string,
  shareId: string,
  ownerUsername: string,
): boolean {
  const share = readStoredShare(topic, slug, shareId);
  if (!share || share.ownerUsername !== ownerUsername) return false;
  const marked = withPaperMutation(slug, () => {
    if (!readStoredShare(topic, slug, shareId)) return false;
    writeJson(path.join(sharesDir(topic, slug), `${shareId}.revoked`), {
      ownerUsername: share.ownerUsername,
      ownerGeneration: share.ownerGeneration,
    });
    return true;
  });
  if (!marked) return false;
  removeCollaborationFiles(share);
  try {
    fs.unlinkSync(sharePath(topic, slug, shareId));
    syncDirectory(sharesDir(topic, slug));
    return true;
  } catch {
    return false;
  }
}

function removeCollaborationFiles(share: PaperShare): void {
  const root = path.join(
    companionDir(share.topic, share.slug),
    "collaboration",
  );
  const directory = path.join(root, share.id);
  if (!fs.existsSync(directory)) return;
  fs.rmSync(directory, { recursive: true, force: true });
  syncDirectory(root);
}

function eraseOwnedCollaborationCopies(
  directory: string,
  username: string,
): void {
  const root = path.join(directory, "collaboration");
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SHARE_ID_RE.test(entry.name)) continue;
    const folder = path.join(root, entry.name);
    const marker = path.join(folder, "owner.json");
    if (!fs.existsSync(marker)) {
      const share = parseShareFile(
        path.join(directory, "shares", `${entry.name}.json`),
      );
      if (!share)
        throw new ShareError(
          "Collaboration ownership cannot be read during profile erasure.",
        );
      if (share.ownerUsername === username)
        fs.rmSync(folder, { recursive: true, force: true });
      continue;
    }
    const owner = z
      .object({
        username: z.string().refine(isValidSlug),
        generation: z.number().int().nonnegative(),
        shareId: z.string().regex(SHARE_ID_RE),
      })
      .strict()
      .parse(JSON.parse(fs.readFileSync(marker, "utf8")));
    if (owner.shareId !== entry.name)
      throw new ShareError("Collaboration ownership is inconsistent.");
    if (owner.username === username)
      fs.rmSync(folder, { recursive: true, force: true });
  }
  syncDirectory(root);
}

/** Profile deletion must revoke links that otherwise outlive their owner. */
export function deleteSharesByOwner(ownerUsername: string): void {
  assertSlug(ownerUsername);
  visitPaperCompanions(({ directory }) => {
    eraseOwnedCollaborationCopies(directory, ownerUsername);
    const root = path.join(directory, "shares");
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isFile() && /^[a-f0-9]{64}\.revoked$/.test(entry.name)) {
        const file = path.join(root, entry.name);
        const owner = z
          .object({
            ownerUsername: z.string().refine(isValidSlug),
            ownerGeneration: z.number().int().nonnegative().optional(),
          })
          .strict()
          .parse(JSON.parse(fs.readFileSync(file, "utf8")));
        if (owner.ownerUsername === ownerUsername) fs.unlinkSync(file);
        continue;
      }
      if (
        !entry.isFile() ||
        (!entry.name.endsWith(".json") &&
          !/^\.[a-f0-9]{64}\.[a-f0-9-]{36}\.tmp$/.test(entry.name))
      )
        continue;
      const file = path.join(root, entry.name);
      if (fs.statSync(file).size > MAX_SHARE_BYTES)
        throw new ShareError(
          "Share ownership cannot be read: record exceeds size limit.",
        );
      const share = shareRecordSchema.parse(
        JSON.parse(fs.readFileSync(file, "utf8")),
      );
      if (share.ownerUsername === ownerUsername) fs.rmSync(file);
    }
    syncDirectory(root);
  });
}

export function unpublishOwnerChat(
  share: PaperShare,
  capability: ProfileCapability,
  chatId: string,
): void {
  if (!CHAT_ID_RE.test(chatId)) throw new ShareError("Invalid conversation.");
  withProfileFiles(new PapernookIdentityStore(dataRoot()), capability, () =>
    withShareFiles(share, () => {
      if (
        share.ownerUsername !== capability.username ||
        share.ownerGeneration !== capability.generation
      )
        throw new ShareError(
          "Only the sharing owner can withdraw this conversation.",
        );
      const current = readStoredShare(share.topic, share.slug, share.id);
      if (!current) throw new ShareError("Unknown share.");
      persistShare({
        ...current,
        conversations: current.conversations.filter(
          (chat) => chat.header.id !== chatId,
        ),
      });
      const actorId = ownerActorId(share);
      unpublishThread(share, { id: actorId }, chatId);
      const file = path.join(
        companionDir(share.topic, share.slug),
        "collaboration",
        share.id,
        "owner-chats.json",
      );
      if (!fs.existsSync(file)) return;
      const ids = z
        .array(z.string().regex(CHAT_ID_RE))
        .max(MAX_CONVERSATIONS)
        .parse(JSON.parse(fs.readFileSync(file, "utf8")));
      const temp = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(
          temp,
          JSON.stringify(ids.filter((id) => id !== chatId)),
          { mode: 0o600, flag: "wx", flush: true },
        );
        fs.renameSync(temp, file);
        syncDirectory(path.dirname(file));
      } finally {
        fs.rmSync(temp, { force: true });
      }
    }),
  );
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
