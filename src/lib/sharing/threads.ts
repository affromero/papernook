import fs from "node:fs";
import path from "node:path";
import { syncDirectory } from "thesidedoor-core/storage";
import { pdfEtag } from "../library/pdf/file";
import { withShareFiles, getShare, type PaperShare } from "../library/shares";
import { validateAssets, sourceThreads, packageOwnerThread } from "./bundle";
import {
  collaborationDir,
  writeJson,
  type Participant,
  ownerActorId,
} from "./storage";
import type { Chat } from "../library/chats";
import {
  publishedThreadSchema,
  type PublishedThread,
  SharingError,
  idSchema,
  sharingStatusSchema,
} from "./schema";

export function readPublishedThreads(share: PaperShare): PublishedThread[] {
  const directory = path.join(collaborationDir(share), "threads");
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => /^[a-f0-9]{16}-[a-f0-9]{16}\.json$/.test(name))
    .map((name) =>
      publishedThreadSchema.parse(
        JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")),
      ),
    );
}

export function unpublishThread(
  share: PaperShare,
  participant: Pick<Participant, "id">,
  id: string,
): void {
  idSchema.parse(id);
  const file = path.join(
    collaborationDir(share),
    "threads",
    `${participant.id}-${id}.json`,
  );
  withShareFiles(share, () => {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      syncDirectory(path.dirname(file));
    }
  });
}

export function collaborationThreads(share: PaperShare): PublishedThread[] {
  return withShareFiles(share, () => readPublishedThreads(share));
}

/** The approved actor owns this namespace. Names in a submitted chat have no authority. */
export function publicationRevision(
  value: Pick<PublishedThread, "chat" | "assets">,
  actorId: string,
): string {
  const chat = {
    ...value.chat,
    header: { ...value.chat.header, username: actorId },
  };
  return pdfEtag(Buffer.from(JSON.stringify({ chat, assets: value.assets })));
}

export function publishThread(
  share: PaperShare,
  participant: Pick<Participant, "id" | "name">,
  value: Pick<PublishedThread, "chat" | "assets">,
  expected: string | null,
): PublishedThread {
  validateAssets(value);
  const chat = {
    ...value.chat,
    header: { ...value.chat.header, username: participant.id },
  };
  const revision = publicationRevision(value, participant.id);
  const published: PublishedThread = {
    id: chat.header.id,
    actorId: participant.id,
    author: participant.name,
    revision,
    chat,
    assets: value.assets,
  };
  const file = path.join(
    collaborationDir(share),
    "threads",
    `${participant.id}-${published.id}.json`,
  );
  const current = fs.existsSync(file)
    ? publishedThreadSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")))
    : null;
  if (current?.revision === revision) return current;
  if ((current?.revision ?? null) !== expected)
    throw new SharingError(
      "This shared conversation changed elsewhere. Refresh before publishing.",
      409,
    );
  if (!current && readPublishedThreads(share).length >= 100)
    throw new SharingError(
      "This collaboration has reached its conversation limit.",
      413,
    );
  const total = readPublishedThreads(share)
    .filter(
      (thread) =>
        thread.actorId !== participant.id || thread.id !== published.id,
    )
    .reduce(
      (bytes, thread) => bytes + Buffer.byteLength(JSON.stringify(thread)),
      0,
    );
  if (total + Buffer.byteLength(JSON.stringify(published)) > 32 * 1024 * 1024)
    throw new SharingError(
      "This collaboration has reached its 32 MB conversation limit.",
      413,
    );
  withShareFiles(share, () => writeJson(file, published));
  return published;
}

export function publishOwnerSnapshot(share: PaperShare, chat: Chat): void {
  const thread = packageOwnerThread(share, chat);
  const existing = readPublishedThreads(share).find(
    (entry) => entry.actorId === thread.actorId && entry.id === thread.id,
  );
  publishThread(
    share,
    { id: thread.actorId, name: thread.author },
    thread,
    existing?.revision ?? null,
  );
}

export function sharingSyncStatus(share: PaperShare) {
  const file = path.join(collaborationDir(share), "sync-status.json");
  return fs.existsSync(file)
    ? sharingStatusSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")))
    : null;
}

export function synchronizeOwnerThreads(share: PaperShare): void {
  // Refresh after acquiring authority so queued work follows current selections.
  const latest = withShareFiles(share, () =>
    getShare(share.topic, share.slug, share.id),
  );
  if (!latest) throw new SharingError("Unknown collaboration.", 404);
  share = latest;
  try {
    const desired = sourceThreads(share, true);
    const actorId = ownerActorId(share);
    const existing = readPublishedThreads(share);
    for (const thread of desired) {
      const previous = existing.find(
        (entry) => entry.actorId === actorId && entry.id === thread.id,
      );
      publishThread(
        share,
        { id: actorId, name: thread.author },
        thread,
        previous?.revision ?? null,
      );
    }
    for (const thread of existing)
      if (
        thread.actorId === actorId &&
        !desired.some((entry) => entry.id === thread.id)
      )
        unpublishThread(share, { id: actorId }, thread.id);
    withShareFiles(share, () =>
      writeJson(path.join(collaborationDir(share), "sync-status.json"), {
        error: null,
        at: new Date().toISOString(),
      }),
    );
  } catch (error) {
    withShareFiles(share, () =>
      writeJson(path.join(collaborationDir(share), "sync-status.json"), {
        error:
          "A published conversation could not sync. Check the sharing limits or stop sharing that conversation.",
        at: new Date().toISOString(),
      }),
    );
    throw error;
  }
}
