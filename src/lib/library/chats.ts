import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { syncDirectory } from "thesidedoor-core/storage";
import {
  companionDir,
  visitPaperCompanions,
  withPaperMutation,
} from "./papers";
import { assertSlug } from "./slug";
import type { RepositorySourceIdentity } from "../github-source";

/**
 * Per-paper, per-account conversations as jsonl files:
 *   data/library/<topic>/<slug>/chats/<username>/<chat-id>.jsonl
 * Line 1 is the chat header; every following line is one message. The first
 * user turn replaces the new-chat header atomically; later turns append.
 */

export interface ChatHeader {
  id: string;
  title: string;
  titleSource: "placeholder" | "generated" | "manual";
  username: string;
  createdAt: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Paths (relative to the companion dir) of attached crop images. */
  images?: string[];
  /** Immutable source identity verified before a repository-analysis turn. */
  repositorySource?: RepositorySourceIdentity;
  at: string;
}

export interface Chat {
  header: ChatHeader;
  messages: ChatMessage[];
}

const CHAT_ID_RE = /^[a-f0-9]{16}$/;
export const NEW_CHAT_TITLE = "New chat";
const MAX_CHAT_TITLE_LENGTH = 72;
export const MAX_MANUAL_CHAT_TITLE_LENGTH = 120;

function headerHasPlaceholderTitle(header: ChatHeader): boolean {
  return header.titleSource === "placeholder";
}

export function chatNeedsGeneratedTitle(chat: Chat): boolean {
  return (
    headerHasPlaceholderTitle(chat.header) &&
    !chat.messages.some((message) => message.role === "user")
  );
}

export function normalizeGeneratedChatTitle(value: string): string {
  const normalized = value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .trim();
  if (!normalized) throw new Error("The AI provider returned an empty title.");
  const characters = Array.from(normalized);
  if (characters.length <= MAX_CHAT_TITLE_LENGTH) return normalized;
  return `${characters.slice(0, MAX_CHAT_TITLE_LENGTH).join("").trimEnd()}…`;
}

export function normalizeManualChatTitle(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) throw new Error("Conversation title cannot be empty.");
  if (Array.from(normalized).length > MAX_MANUAL_CHAT_TITLE_LENGTH) {
    throw new Error(
      `Conversation title cannot exceed ${MAX_MANUAL_CHAT_TITLE_LENGTH} characters.`,
    );
  }
  return normalized;
}

function chatsDir(
  topic: string | null,
  slug: string,
  username: string,
): string {
  assertSlug(username);
  return path.join(companionDir(topic, slug), "chats", username);
}

function chatPath(
  topic: string | null,
  slug: string,
  username: string,
  chatId: string,
): string {
  if (!CHAT_ID_RE.test(chatId)) throw new Error(`Invalid chat id: ${chatId}`);
  return path.join(chatsDir(topic, slug, username), `${chatId}.jsonl`);
}

export function createChat(
  topic: string | null,
  slug: string,
  username: string,
  title: string,
): ChatHeader {
  return withPaperMutation(slug, () =>
    createChatLocked(topic, slug, username, title),
  );
}

function createChatLocked(
  topic: string | null,
  slug: string,
  username: string,
  title: string,
): ChatHeader {
  const header: ChatHeader = {
    id: crypto.randomBytes(8).toString("hex"),
    title: Array.from(title).slice(0, MAX_MANUAL_CHAT_TITLE_LENGTH).join(""),
    titleSource: title === NEW_CHAT_TITLE ? "placeholder" : "manual",
    username,
    createdAt: new Date().toISOString(),
  };
  const dir = chatsDir(topic, slug, username);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    chatPath(topic, slug, username, header.id),
    `${JSON.stringify(header)}\n`,
  );
  return header;
}

export function appendMessage(
  topic: string | null,
  slug: string,
  username: string,
  chatId: string,
  message: ChatMessage,
): void {
  const file = chatPath(topic, slug, username, chatId);
  const descriptor = fs.openSync(
    file,
    fs.constants.O_WRONLY | fs.constants.O_APPEND,
  );
  try {
    fs.writeSync(descriptor, `${JSON.stringify(message)}\n`);
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Append the first user turn and permanently name a placeholder conversation
 * from that query in the same filesystem replacement.
 */
export function appendUserMessage(
  topic: string | null,
  slug: string,
  username: string,
  chatId: string,
  message: ChatMessage,
  generatedTitle: string | null,
): ChatHeader {
  if (message.role !== "user") {
    throw new Error("appendUserMessage requires a user message");
  }
  const file = chatPath(topic, slug, username, chatId);
  const raw = fs.readFileSync(file, "utf8");
  const firstNewline = raw.indexOf("\n");
  if (firstNewline < 0) throw new Error("Invalid chat file");

  const header = JSON.parse(raw.slice(0, firstNewline)) as ChatHeader;
  const existing = raw.slice(firstNewline + 1);
  const alreadyHasUser = existing
    .split("\n")
    .filter(Boolean)
    .some((line) => {
      try {
        return (JSON.parse(line) as ChatMessage).role === "user";
      } catch {
        return false;
      }
    });
  if (alreadyHasUser || !headerHasPlaceholderTitle(header)) {
    appendMessage(topic, slug, username, chatId, message);
    return header;
  }

  if (generatedTitle === null) {
    throw new Error("The first user message requires an AI-generated title.");
  }
  const titled: ChatHeader = {
    ...header,
    title: normalizeGeneratedChatTitle(generatedTitle),
    titleSource: "generated",
  };
  const tmp = `${file}.tmp-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(
      tmp,
      `${JSON.stringify(titled)}\n${existing}${JSON.stringify(message)}\n`,
    );
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  return titled;
}

export function readChat(
  topic: string | null,
  slug: string,
  username: string,
  chatId: string,
): Chat | null {
  let raw: string;
  try {
    raw = fs.readFileSync(chatPath(topic, slug, username, chatId), "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;
  try {
    const header = JSON.parse(lines[0]) as ChatHeader;
    if (!["placeholder", "generated", "manual"].includes(header.titleSource))
      throw new Error("Chat header requires title provenance migration.");
    const messages = lines.slice(1).map((l) => JSON.parse(l) as ChatMessage);
    return { header, messages };
  } catch {
    return null;
  }
}

/** Replace a caller-owned chat title without touching its message bytes. */
export function renameChat(
  topic: string | null,
  slug: string,
  username: string,
  chatId: string,
  title: string,
): ChatHeader | null {
  const file = chatPath(topic, slug, username, chatId);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const firstNewline = raw.indexOf("\n");
  if (firstNewline < 0) throw new Error("Invalid chat file");
  const header = JSON.parse(raw.slice(0, firstNewline)) as ChatHeader;
  const renamed: ChatHeader = {
    ...header,
    title: normalizeManualChatTitle(title),
    titleSource: "manual",
  };
  const tmp = `${file}.tmp-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(
      tmp,
      `${JSON.stringify(renamed)}${raw.slice(firstNewline)}`,
    );
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  return renamed;
}

/**
 * Remove one message (by position, guarded by its timestamp so a stale
 * client can't delete the wrong line) and its pasted-image files. Rewrites
 * the jsonl atomically; crop filenames are unique per message, so removing
 * this message's images never orphans another reference.
 */
export function deleteMessage(
  topic: string | null,
  slug: string,
  username: string,
  chatId: string,
  index: number,
  at: string,
): boolean {
  const chat = readChat(topic, slug, username, chatId);
  const target = chat?.messages[index];
  if (!chat || !target || target.at !== at) return false;

  const file = chatPath(topic, slug, username, chatId);
  const kept = chat.messages.filter((_, i) => i !== index);
  const lines = [chat.header, ...kept].map((l) => JSON.stringify(l));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${lines.join("\n")}\n`);
  fs.renameSync(tmp, file);

  const companion = companionDir(topic, slug);
  for (const image of target.images ?? []) {
    if (/^crops\/[a-zA-Z0-9._-]+$/.test(image)) {
      fs.rmSync(path.join(companion, image), { force: true });
    }
  }
  return true;
}

/**
 * Delete one caller-owned conversation and the crop files referenced only by
 * its messages. Opening existing chat files is required for later appends, so
 * an assistant finishing after this unlink cannot recreate the conversation.
 */
export function deleteChat(
  topic: string | null,
  slug: string,
  username: string,
  chatId: string,
): boolean {
  const chat = readChat(topic, slug, username, chatId);
  if (!chat) return false;

  const file = chatPath(topic, slug, username, chatId);
  try {
    fs.rmSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }

  const companion = companionDir(topic, slug);
  const images = new Set(
    chat.messages.flatMap((message) =>
      (message.images ?? []).filter((image) =>
        /^crops\/[a-zA-Z0-9._-]+$/.test(image),
      ),
    ),
  );
  for (const image of images) {
    fs.rmSync(path.join(companion, image), { force: true });
  }

  const crops = path.join(companion, "crops");
  try {
    if (fs.readdirSync(crops).length === 0) fs.rmdirSync(crops);
  } catch {
    // Missing/non-empty crops directory: nothing else to remove.
  }
  return true;
}

export function listChats(
  topic: string | null,
  slug: string,
  username: string,
): ChatHeader[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(chatsDir(topic, slug, username));
  } catch {
    return [];
  }
  const headers: ChatHeader[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const chat = readChat(topic, slug, username, entry.replace(/\.jsonl$/, ""));
    if (chat) headers.push(chat.header);
  }
  return headers.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Erase one profile's conversations and their pasted-image files everywhere.
 * Shared paper companions remain intact for the other profiles.
 */
export function deleteChatsByUser(username: string): void {
  assertSlug(username);
  visitPaperCompanions(({ directory }) => {
    const userChats = path.join(directory, "chats", username);
    let entries: string[];
    try {
      entries = fs.readdirSync(userChats);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        const parent = path.dirname(userChats);
        syncDirectory(fs.existsSync(parent) ? parent : directory);
        return;
      }
      throw error;
    }
    const images = new Set<string>();
    for (const file of entries) {
      if (!/^[a-f0-9]{16}\.jsonl(?:\.tmp(?:-[a-f0-9-]{36})?)?$/.test(file))
        continue;
      const lines = fs
        .readFileSync(path.join(userChats, file), "utf8")
        .split("\n");
      const header: unknown = JSON.parse(lines[0] ?? "");
      if (
        !header ||
        typeof header !== "object" ||
        !("username" in header) ||
        header.username !== username
      ) {
        throw new Error("Chat attachment ownership cannot be read.");
      }
      for (const line of lines.slice(1)) {
        if (!line.trim()) continue;
        const message: unknown = JSON.parse(line);
        if (!message || typeof message !== "object")
          throw new Error("Chat attachment ownership cannot be read.");
        if (!("images" in message) || message.images === undefined) continue;
        if (!Array.isArray(message.images))
          throw new Error("Chat attachment ownership cannot be read.");
        for (const image of message.images) {
          if (
            typeof image !== "string" ||
            !/^crops\/[a-zA-Z0-9._-]+$/.test(image)
          )
            throw new Error("Chat attachment ownership cannot be read.");
          images.add(path.join(directory, image));
        }
      }
    }
    // Keep the ownership records until every attachment has been removed.
    for (const image of images) fs.rmSync(image, { force: true });
    if (images.size > 0) {
      const crops = path.join(directory, "crops");
      syncDirectory(fs.existsSync(crops) ? crops : directory);
    }
    fs.rmSync(userChats, { recursive: true, force: true });
    syncDirectory(path.dirname(userChats));
  });
}
