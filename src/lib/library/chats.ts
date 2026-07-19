import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { libraryRoot } from "../data-dir";
import { companionDir } from "./papers";
import { assertSlug } from "./slug";

/**
 * Per-paper, per-account conversations as jsonl files:
 *   data/library/<topic>/<slug>/chats/<username>/<chat-id>.jsonl
 * Line 1 is the chat header; every following line is one message. Files are
 * append-only during a conversation, so resume = read the file back.
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
  fs.appendFileSync(
    chatPath(topic, slug, username, chatId),
    `${JSON.stringify(message)}\n`,
  );
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
    const messages = lines.slice(1).map((l) => JSON.parse(l) as ChatMessage);
    return { header, messages };
  } catch {
    return null;
  }
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
