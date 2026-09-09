import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { usersRoot } from "@/lib/data-dir";
import { assertSlug } from "@/lib/library/slug";
import type { Chat, ChatMessage } from "@/lib/library/chats";

export const sourceMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(500_000),
});
export const metadataSchema = z.object({
  title: z.string().trim().min(1).max(200),
  topic: z.string().trim().min(1).max(80),
  tags: z.array(z.string().trim().min(1).max(60)).max(30),
});
export const sourceSchema = metadataSchema.extend({
  provider: z.enum(["chatgpt", "claude", "codex", "transcript"]),
  sourceUrl: z
    .string()
    .url()
    .refine(
      (value) => /^https?:\/\//i.test(value),
      "Source URL must use HTTP or HTTPS.",
    )
    .optional(),
  messages: z.array(sourceMessageSchema).min(1).max(2000),
});
export type ConversationSource = z.infer<typeof sourceSchema>;
export type Conversation = ConversationSource & {
  id: string;
  version: 1;
  importedAt: string;
};
const recordSchema = sourceSchema.extend({
  id: z.string(),
  version: z.literal(1),
  importedAt: z.string(),
});
export const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;

function root(username: string): string {
  assertSlug(username);
  return path.join(usersRoot(), username, "conversations");
}
function directory(username: string, id: string): string {
  assertSlug(id);
  return path.join(root(username), id);
}
function atomic(file: string, value: string): void {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, value, { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
export function createConversation(
  username: string,
  input: ConversationSource,
): Conversation {
  const source = sourceSchema.parse(input);
  if (Buffer.byteLength(JSON.stringify(source)) > MAX_TRANSCRIPT_BYTES)
    throw new Error("Transcript exceeds the 4 MB limit.");
  const record: Conversation = {
    ...source,
    id: crypto.randomBytes(12).toString("hex"),
    version: 1,
    importedAt: new Date().toISOString(),
  };
  const dir = directory(username, record.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomic(path.join(dir, "source.json"), JSON.stringify(record));
  return record;
}
export function getConversation(
  username: string,
  id: string,
): Conversation | null {
  const dir = directory(username, id);
  if (!fs.existsSync(path.join(dir, "source.json"))) return null;
  const source = recordSchema.parse(
    JSON.parse(fs.readFileSync(path.join(dir, "source.json"), "utf8")),
  );
  const meta = path.join(dir, "meta.json");
  return fs.existsSync(meta)
    ? {
        ...source,
        ...metadataSchema.parse(JSON.parse(fs.readFileSync(meta, "utf8"))),
      }
    : source;
}
export function listConversations(username: string): Conversation[] {
  const dir = root(username);
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.length > 10_000)
    throw new Error("Conversation library exceeds the scan limit.");
  return entries
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const record = getConversation(username, entry.name);
      return record ? [record] : [];
    })
    .sort((a, b) => b.importedAt.localeCompare(a.importedAt));
}
export function updateConversation(
  username: string,
  id: string,
  metadata: z.infer<typeof metadataSchema>,
): Conversation {
  if (!getConversation(username, id))
    throw new Error("Conversation not found.");
  atomic(
    path.join(directory(username, id), "meta.json"),
    JSON.stringify(metadataSchema.parse(metadata)),
  );
  return getConversation(username, id)!;
}
const busy = new Set<string>();
export function lockConversation(username: string, id: string): () => void {
  const key = directory(username, id);
  if (busy.has(key))
    throw new Error("A reply is already running. Wait for it to finish.");
  busy.add(key);
  return () => busy.delete(key);
}
export function deleteConversation(username: string, id: string): void {
  const release = lockConversation(username, id);
  try {
    fs.rmSync(directory(username, id), { recursive: true, force: true });
  } finally {
    release();
  }
}
export function listConversationChats(username: string, id: string): Chat[] {
  if (!getConversation(username, id)) return [];
  const dir = path.join(directory(username, id), "chats");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => /^[a-f0-9]{16}\.jsonl$/.test(name))
    .map((name) => {
      const [header, ...messages] = fs
        .readFileSync(path.join(dir, name), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      return { header, messages } as Chat;
    });
}
export function saveConversationTurn(
  username: string,
  id: string,
  chatId: string | undefined,
  query: string,
  answer: string,
  images?: string[],
): Chat {
  if (!getConversation(username, id))
    throw new Error("Conversation not found.");
  const existing = chatId
    ? listConversationChats(username, id).find(
        (chat) => chat.header.id === chatId,
      )
    : undefined;
  if (chatId && !existing) throw new Error("Chat not found.");
  const at = new Date().toISOString();
  const chat: Chat = existing ?? {
    header: {
      id: crypto.randomBytes(8).toString("hex"),
      username,
      title: Array.from(query).slice(0, 72).join(""),
      titleSource: "manual",
      createdAt: at,
    },
    messages: [],
  };
  const messages: ChatMessage[] = [
    { role: "user", content: query, images, at },
    { role: "assistant", content: answer, at },
  ];
  chat.messages.push(...messages);
  const dir = path.join(directory(username, id), "chats");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomic(
    path.join(dir, `${chat.header.id}.jsonl`),
    [chat.header, ...chat.messages]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n",
  );
  return chat;
}
