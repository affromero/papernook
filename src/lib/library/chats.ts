import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { libraryRoot } from "../data-dir";
import { companionDir } from "./papers";
import { assertSlug } from "./slug";

/**
 * Per-paper, per-account conversations as jsonl files:
 *   data/library/<topic>/<slug>/chats/<username>/<chat-id>.jsonl
 * Line 1 is the chat header; every following line is one message. The first
 * user turn replaces the new-chat header atomically; later turns append.
 */

export interface ChatHeader {
  id: string;
  title: string;
  username: string;
  createdAt: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Paths (relative to the companion dir) of attached crop images. */
  images?: string[];
  at: string;
}

export interface Chat {
  header: ChatHeader;
  messages: ChatMessage[];
}

const CHAT_ID_RE = /^[a-f0-9]{16}$/;
export const NEW_CHAT_TITLE = "New chat";
const MAX_CHAT_TITLE_LENGTH = 72;

/** Build a compact, stable conversation title without another AI request. */
export function titleFromFirstQuery(query: string): string {
  const normalized = query.replace(/\s+/g, " ").trim();
  if (!normalized) return NEW_CHAT_TITLE;
  const characters = Array.from(normalized);
  if (characters.length <= MAX_CHAT_TITLE_LENGTH) return normalized;

  const prefix = characters.slice(0, MAX_CHAT_TITLE_LENGTH + 1).join("");
  const lastSpace = prefix.lastIndexOf(" ");
  const clipped =
    lastSpace >= Math.floor(MAX_CHAT_TITLE_LENGTH * 0.6)
      ? prefix.slice(0, lastSpace)
      : characters.slice(0, MAX_CHAT_TITLE_LENGTH).join("");
  return `${clipped.trimEnd()}…`;
}

function hasGeneratedTitle(title: string): boolean {
  if (title === NEW_CHAT_TITLE) return true;
  const match = title.match(/^Chat\s+\d{1,4}([./-])\d{1,2}\1\d{1,4}$/);
  return Boolean(match);
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
  const header: ChatHeader = {
    id: crypto.randomBytes(8).toString("hex"),
    title: title.slice(0, 120),
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
  if (alreadyHasUser || !hasGeneratedTitle(header.title)) {
    appendMessage(topic, slug, username, chatId, message);
    return header;
  }

  const titled = { ...header, title: titleFromFirstQuery(message.content) };
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
    let header = JSON.parse(lines[0]) as ChatHeader;
    const messages = lines.slice(1).map((l) => JSON.parse(l) as ChatMessage);
    if (hasGeneratedTitle(header.title)) {
      const firstQuery = messages.find((message) => message.role === "user");
      if (firstQuery) {
        header = { ...header, title: titleFromFirstQuery(firstQuery.content) };
      }
    }
    return { header, messages };
  } catch {
    return null;
  }
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
  const root = libraryRoot();
  if (!fs.existsSync(root)) return;

  const visit = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const resolved = path.join(directory, entry.name);
      if (entry.name === username && path.basename(directory) === "chats") {
        const companion = path.dirname(directory);
        const imagePaths = new Set<string>();
        for (const chatFile of fs.readdirSync(resolved)) {
          if (!chatFile.endsWith(".jsonl")) continue;
          const raw = fs.readFileSync(path.join(resolved, chatFile), "utf8");
          for (const line of raw.split("\n").slice(1)) {
            if (!line.trim()) continue;
            try {
              const message = JSON.parse(line) as ChatMessage;
              for (const image of message.images ?? []) {
                if (/^crops\/[a-zA-Z0-9._-]+$/.test(image)) {
                  imagePaths.add(path.join(companion, image));
                }
              }
            } catch {
              // A malformed chat is still removed; it must not block erasure.
            }
          }
        }
        fs.rmSync(resolved, { recursive: true, force: true });
        for (const imagePath of imagePaths) {
          fs.rmSync(imagePath, { force: true });
        }
        const crops = path.join(companion, "crops");
        try {
          if (fs.readdirSync(crops).length === 0) fs.rmdirSync(crops);
        } catch {
          // Missing/non-empty crops directory: nothing else to remove.
        }
        continue;
      }
      visit(resolved);
    }
  };

  visit(root);
}
