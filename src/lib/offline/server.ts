import fs from "node:fs";
import crypto from "node:crypto";
import { z } from "zod";
import { activeProfile } from "@/lib/auth/session";
import { getPaper, readText } from "@/lib/library/papers";
import { listChats, readChat, type Chat } from "@/lib/library/chats";
import { isValidSlug } from "@/lib/library/slug";
import { MAX_PDF_BYTES } from "@/lib/pdf-limits";
import {
  getConversation,
  listConversationChats,
} from "@/lib/conversations/store";
import type { OfflineManifest } from "./types";
import {
  attachmentHtml,
  escapeHtml,
  MAX_STUDY_BYTES,
  renderMarkdown,
  STUDY_CSP,
  studyHtml,
} from "./render";

export const privateHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": STUDY_CSP,
};
export const documentSlug = z.string().refine(isValidSlug);

export function renderMessages(
  messages: { role: string; content: string; images?: string[] }[],
  base?: string,
): string {
  let bytes = 0;
  return messages
    .map((message) => {
      const result = `<article><h2>${escapeHtml(message.role === "user" ? "User" : "Assistant")}</h2>${renderMarkdown(message.content)}${(message.images ?? []).map((image) => attachmentHtml(base, image)).join("")}</article>`;
      bytes += Buffer.byteLength(result);
      if (bytes > MAX_STUDY_BYTES)
        throw new Error("Conversation exceeds the 32 MB export limit.");
      return result;
    })
    .join("");
}

function packageChats(chats: Chat[], owner: string, base?: string) {
  let bytes = 0;
  return chats
    .filter((chat) => chat.header.username === owner)
    .map((chat) => {
      const html = studyHtml(
        chat.header.title,
        renderMessages(chat.messages, base),
      );
      bytes += Buffer.byteLength(html);
      if (bytes > MAX_STUDY_BYTES)
        throw new Error("Saved chats exceed the 32 MB snapshot limit.");
      return { id: chat.header.id, title: chat.header.title, html };
    });
}

function finish(manifest: OfflineManifest): OfflineManifest {
  const serialized = JSON.stringify(manifest);
  if (Buffer.byteLength(serialized) > MAX_STUDY_BYTES)
    throw new Error("Snapshot exceeds the 32 MB text and attachment limit.");
  manifest.updatedAt = crypto
    .createHash("sha256")
    .update(serialized)
    .digest("hex");
  return manifest;
}

export function paperSnapshot(
  owner: string,
  topic: string,
  slug: string,
): OfflineManifest | null {
  documentSlug.parse(owner);
  documentSlug.parse(topic);
  documentSlug.parse(slug);
  const paper = getPaper(topic, slug);
  if (!paper || !fs.existsSync(paper.pdfPath)) return null;
  if (fs.statSync(paper.pdfPath).size > MAX_PDF_BYTES)
    throw new Error("Paper PDF exceeds the 100 MB limit.");
  const text =
    readText(topic, slug) ??
    "Extracted text unavailable. Read the downloaded PDF.";
  const chats = listChats(topic, slug, owner).map((header) => {
    const chat = readChat(topic, slug, owner, header.id);
    if (!chat)
      throw new Error("A saved chat changed during download. Try again.");
    return chat;
  });
  return finish({
    version: 1,
    owner,
    kind: "paper",
    key: `paper:${topic}:${slug}`,
    title: paper.meta.title,
    topic,
    tags: paper.meta.tags,
    onlineUrl: `/paper/${topic}/${slug}`,
    snapshotUrl: `/api/v1/offline/papers/${topic}/${slug}`,
    updatedAt: "",
    text,
    sourceHtml: studyHtml(
      paper.meta.title,
      `<div class="source-text">${escapeHtml(text)}</div>`,
    ),
    summaryHtml: studyHtml(
      "Summary",
      renderMarkdown(paper.summary ?? "No summary available."),
    ),
    chats: packageChats(chats, owner, paper.companionDir),
    pdfUrl: `/api/v1/papers/${topic}/${slug}/pdf`,
  });
}

export function conversationSnapshot(
  owner: string,
  id: string,
): OfflineManifest | null {
  documentSlug.parse(owner);
  documentSlug.parse(id);
  const conversation = getConversation(owner, id);
  if (!conversation) return null;
  return finish({
    version: 1,
    owner,
    kind: "conversation",
    key: `conversation:${id}`,
    title: conversation.title,
    topic: conversation.topic,
    tags: conversation.tags,
    onlineUrl: `/conversations/${id}`,
    snapshotUrl: `/api/v1/offline/conversations/${id}`,
    updatedAt: "",
    text: conversation.messages
      .map((message) => `${message.role}: ${message.content}`)
      .join("\n\n"),
    sourceHtml: studyHtml(
      conversation.title,
      renderMessages(conversation.messages),
    ),
    summaryHtml: "",
    chats: packageChats(listConversationChats(owner, id), owner),
  });
}

export async function snapshotResponse(
  build: (owner: string) => OfflineManifest | null,
): Promise<Response> {
  const profile = await activeProfile();
  if (!profile)
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: privateHeaders },
    );
  try {
    const manifest = build(profile.username);
    return manifest
      ? Response.json(manifest, { headers: privateHeaders })
      : Response.json(
          { error: "Document not found" },
          { status: 404, headers: privateHeaders },
        );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof z.ZodError
            ? "Invalid document identifier"
            : error instanceof Error
              ? error.message
              : "Snapshot failed",
      },
      {
        status: error instanceof z.ZodError ? 400 : 422,
        headers: privateHeaders,
      },
    );
  }
}
