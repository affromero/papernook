import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  type Chat,
  readChat,
  createChat,
  appendMessage,
} from "../library/chats";
import { type PaperShare, withShareFiles } from "../library/shares";
import {
  getPaper,
  readText,
  uniqueSlug,
  companionDir,
  writeMeta,
  writeSummary,
  writeText,
  acceptFromInbox,
} from "../library/papers";
import { readVersionedPdf, pdfEtag } from "../library/pdf/file";
import { MAX_PDF_BYTES } from "../pdf-limits";
import { dataRoot } from "../data-dir";
import { getProfile } from "../auth/users";
import { writeCaptureOwner } from "../capture/jobs/ownership";
import { PapernookIdentityStore } from "../auth/identity-store";
import {
  withProfileActivity,
  withProfileFiles,
  type ProfileCapability,
} from "../auth/profile-capability";
import { digest, ownerActorId } from "./storage";
import {
  bundleSchema,
  conversationSchema,
  MAX_CHAT_BYTES,
  type PaperBundle,
  type PublishedThread,
  SharingError,
  idSchema,
  MAX_BUNDLE_BYTES,
} from "./schema";

/** Export only referenced local raster images. No private companion traversal. */
export function packageConversation(
  chat: Chat,
  directory: string,
): { chat: PublishedThread["chat"]; assets: PublishedThread["assets"] } {
  const assets: Record<string, string> = {};
  const messages = chat.messages.map((message) => ({
    role: message.role,
    content: message.content,
    at: message.at,
    images: message.images?.map((image) => {
      const match =
        /^crops\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,199}\.(png|jpg|jpeg|webp|gif))$/.exec(
          image,
        );
      if (!match)
        throw new SharingError(
          "A conversation contains an unsupported attachment.",
        );
      const file = path.join(directory, "crops", match[1]);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > MAX_CHAT_BYTES)
        throw new SharingError(
          "A conversation attachment is unavailable or too large.",
        );
      const bytes = fs.readFileSync(file);
      const name = `${digest(bytes)}.${match[2]}`;
      assets[name] = bytes.toString("base64");
      return `crops/${name}`;
    }),
  }));
  const packaged = {
    chat: conversationSchema.parse({ header: chat.header, messages }),
    assets,
  };
  if (Buffer.byteLength(JSON.stringify(packaged)) > MAX_CHAT_BYTES)
    throw new SharingError(
      "The conversation exceeds the 8 MB sharing limit.",
      413,
    );
  return packaged;
}

export function validateAssets(
  thread: Pick<PublishedThread, "chat" | "assets">,
): void {
  const references = new Set(
    thread.chat.messages
      .flatMap((message) => message.images ?? [])
      .map((p) => p.slice(6)),
  );
  const names = Object.keys(thread.assets);
  if (
    names.length !== references.size ||
    names.some((name) => !references.has(name))
  )
    throw new SharingError("Only referenced chat images can be shared.");
  for (const [name, encoded] of Object.entries(thread.assets)) {
    const bytes = Buffer.from(encoded, "base64");
    if (digest(bytes) !== name.split(".")[0])
      throw new SharingError("A shared image has an invalid digest.");
    const extension = name.split(".").at(-1);
    const valid =
      extension === "png"
        ? bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : extension === "jpg" || extension === "jpeg"
          ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : extension === "gif"
            ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"))
            : bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
              bytes.subarray(8, 12).toString("ascii") === "WEBP";
    if (!valid)
      throw new SharingError("A shared image does not match its file type.");
  }
}

export function sourceThreads(
  share: PaperShare,
  live: boolean,
): PublishedThread[] {
  return withShareFiles(share, () => {
    const file = path.join(
      companionDir(share.topic, share.slug),
      "collaboration",
      share.id,
      "owner-chats.json",
    );
    const extraIds =
      live && fs.existsSync(file)
        ? z
            .array(idSchema)
            .max(20)
            .parse(JSON.parse(fs.readFileSync(file, "utf8")))
        : [];
    const snapshots = [
      ...share.conversations,
      ...extraIds.flatMap((id) => {
        const chat = readChat(share.topic, share.slug, share.ownerUsername, id);
        return chat ? [chat] : [];
      }),
    ];
    return snapshots.flatMap((snapshot) => {
      const current = live
        ? readChat(
            share.topic,
            share.slug,
            share.ownerUsername,
            snapshot.header.id,
          )
        : snapshot;
      if (!current) return [];
      return [packageOwnerThread(share, current as Chat)];
    });
  });
}

export function packageOwnerThread(
  share: PaperShare,
  chat: Chat,
): PublishedThread {
  const packaged = packageConversation(
    chat,
    companionDir(share.topic, share.slug),
  );
  return {
    ...packaged,
    id: chat.header.id,
    actorId: ownerActorId(share),
    author: getProfile(share.ownerUsername)?.displayName ?? share.ownerUsername,
    revision: pdfEtag(Buffer.from(JSON.stringify(packaged))),
  };
}

export async function exportBundle(
  share: PaperShare,
  conversations?: PublishedThread[],
): Promise<PaperBundle> {
  if (share.mode === "view")
    throw new SharingError("This link permits viewing only.", 403);
  const pdf = await readVersionedPdf(share.topic, share.slug);
  if (!pdf) throw new SharingError("Unknown paper.", 404);
  return withShareFiles(share, () => {
    const paper = getPaper(share.topic, share.slug);
    if (!paper) throw new SharingError("Unknown paper.", 404);
    const { title, authors, year, venue, arxivId, bibtex, tags, sourceUrl } =
      paper.meta;
    const bundle = bundleSchema.parse({
      version: 1,
      mode: share.mode,
      slug: share.slug,
      meta: { title, authors, year, venue, arxivId, bibtex, tags, sourceUrl },
      summary: paper.summary,
      text: readText(share.topic, share.slug),
      pdf: Buffer.from(pdf.bytes).toString("base64"),
      etag: pdf.etag,
      conversations: conversations ?? sourceThreads(share, false),
    });
    if (Buffer.byteLength(JSON.stringify(bundle)) > MAX_BUNDLE_BYTES)
      throw new SharingError(
        "This reading exceeds the sharing transfer limit.",
        413,
      );
    return bundle;
  });
}

export async function importBundle(
  bundle: PaperBundle,
  topic: string,
  capability: ProfileCapability,
  linked = false,
) {
  const parsed = bundleSchema.parse(bundle);
  const pdf = Buffer.from(parsed.pdf, "base64");
  validateSharedPdf(pdf, parsed.etag);
  for (const thread of parsed.conversations) validateAssets(thread);
  const identity = new PapernookIdentityStore(dataRoot());
  return withProfileActivity(identity, capability, async () => {
    const base = uniqueSlug(parsed.slug);
    let slug = base;
    let directory = companionDir(null, slug);
    fs.mkdirSync(path.dirname(directory), { recursive: true });
    for (;;) {
      try {
        fs.mkdirSync(directory, { mode: 0o700 });
        break;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "EEXIST"
        )
          throw error;
        slug = `${base.slice(0, 62)}-${randomBytes(6).toString("hex")}`;
        directory = companionDir(null, slug);
      }
    }
    try {
      return withProfileFiles(identity, capability, () => {
        writeCaptureOwner(directory, capability);
        fs.writeFileSync(path.join(directory, "paper.pdf"), pdf, {
          mode: 0o600,
          flag: "wx",
        });
        writeMeta(null, slug, {
          ...parsed.meta,
          addedBy: capability.username,
          addedAt: new Date().toISOString(),
          related: [],
        });
        if (parsed.summary) writeSummary(null, slug, parsed.summary);
        if (parsed.text) writeText(null, slug, parsed.text);
        if (!linked)
          for (const thread of parsed.conversations) {
            const header = createChat(
              null,
              slug,
              capability.username,
              `${thread.author}: ${thread.chat.header.title}`.slice(0, 120),
            );
            for (const message of thread.chat.messages)
              appendMessage(
                null,
                slug,
                capability.username,
                header.id,
                message,
              );
            for (const [name, data] of Object.entries(thread.assets)) {
              fs.mkdirSync(path.join(directory, "crops"), { recursive: true });
              fs.writeFileSync(
                path.join(directory, "crops", name),
                Buffer.from(data, "base64"),
                { mode: 0o600 },
              );
            }
          }
        return withProfileFiles(identity, capability, () =>
          acceptFromInbox(slug, topic),
        );
      });
    } catch (error) {
      fs.rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  });
}

export function validateSharedPdf(pdf: Uint8Array, etag: string): void {
  const bytes = Buffer.from(pdf);
  if (
    bytes.byteLength > MAX_PDF_BYTES ||
    pdfEtag(bytes) !== etag ||
    !bytes.subarray(0, 1024).toString("latin1").includes("%PDF-") ||
    !bytes.subarray(-1024).toString("latin1").includes("%%EOF")
  )
    throw new SharingError("The shared PDF is invalid or incomplete.", 422);
}
