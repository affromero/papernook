import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-chat-delete-"));
  process.env.PAPERNOOK_DATA_DIR = tmpDir;
  vi.resetModules();
  vi.doMock("@/lib/auth/session", () => ({
    activeProfile: async () => ({ username: "andres" }),
  }));
});

afterEach(async () => {
  vi.doUnmock("@/lib/auth/session");
  const { closeIndex } = await import("@/lib/library/index-db");
  closeIndex();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function seedChat() {
  const chats = await import("@/lib/library/chats");
  const chat = chats.createChat("ml", "paper", "andres", "First chat");
  chats.appendMessage("ml", "paper", "andres", chat.id, {
    role: "user",
    content: "first question",
    at: "2026-08-10T10:00:00.000Z",
  });
  chats.appendMessage("ml", "paper", "andres", chat.id, {
    role: "assistant",
    content: "first answer",
    at: "2026-08-10T10:00:05.000Z",
  });
  return { chats, chatId: chat.id };
}

describe("deleteMessage", () => {
  it("removes only the targeted message and keeps the rest readable", async () => {
    const { chats, chatId } = await seedChat();
    const removed = chats.deleteMessage(
      "ml",
      "paper",
      "andres",
      chatId,
      0,
      "2026-08-10T10:00:00.000Z",
    );
    expect(removed).toBe(true);
    const stored = chats.readChat("ml", "paper", "andres", chatId);
    expect(stored?.messages.map((m) => m.content)).toEqual(["first answer"]);
    expect(stored?.header.title).toBe("First chat");
  });

  it("rejects a stale timestamp without touching the file", async () => {
    const { chats, chatId } = await seedChat();
    expect(
      chats.deleteMessage("ml", "paper", "andres", chatId, 0, "2020-01-01"),
    ).toBe(false);
    expect(
      chats.deleteMessage("ml", "paper", "andres", chatId, 7, "2020-01-01"),
    ).toBe(false);
    const stored = chats.readChat("ml", "paper", "andres", chatId);
    expect(stored?.messages).toHaveLength(2);
  });

  it("deletes the message's crop files but not other crops", async () => {
    const { chats, chatId } = await seedChat();
    const papers = await import("@/lib/library/papers");
    const companion = papers.companionDir("ml", "paper");
    const crops = path.join(companion, "crops");
    fs.mkdirSync(crops, { recursive: true });
    fs.writeFileSync(path.join(crops, "mine.png"), "png");
    fs.writeFileSync(path.join(crops, "other.png"), "png");
    chats.appendMessage("ml", "paper", "andres", chatId, {
      role: "user",
      content: "look at this",
      images: ["crops/mine.png"],
      at: "2026-08-10T10:01:00.000Z",
    });

    chats.deleteMessage(
      "ml",
      "paper",
      "andres",
      chatId,
      2,
      "2026-08-10T10:01:00.000Z",
    );
    expect(fs.existsSync(path.join(crops, "mine.png"))).toBe(false);
    expect(fs.existsSync(path.join(crops, "other.png"))).toBe(true);
  });
});

describe("DELETE /chats/[chatId]", () => {
  async function callDelete(chatId: string, body: unknown) {
    const route =
      await import("@/app/api/v1/papers/[topic]/[slug]/chats/[chatId]/route");
    return route.DELETE(
      new NextRequest("http://localhost/chat", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ topic: "ml", slug: "paper", chatId }) },
    );
  }

  it("deletes the addressed message from the caller's chat", async () => {
    const { chats, chatId } = await seedChat();
    const response = await callDelete(chatId, {
      index: 1,
      at: "2026-08-10T10:00:05.000Z",
    });
    expect(response.status).toBe(200);
    const stored = chats.readChat("ml", "paper", "andres", chatId);
    expect(stored?.messages.map((m) => m.content)).toEqual(["first question"]);
  });

  it("responds 409 on a stale index/timestamp so the client resyncs", async () => {
    const { chats, chatId } = await seedChat();
    const response = await callDelete(chatId, { index: 1, at: "2020-01-01" });
    expect(response.status).toBe(409);
    expect(
      chats.readChat("ml", "paper", "andres", chatId)?.messages,
    ).toHaveLength(2);
  });

  it("rejects malformed bodies", async () => {
    const { chatId } = await seedChat();
    const response = await callDelete(chatId, { index: -1, at: "" });
    expect(response.status).toBe(400);
  });

  it("cannot reach another profile's chat", async () => {
    const chats = await import("@/lib/library/chats");
    const other = chats.createChat("ml", "paper", "someone-else", "Private");
    chats.appendMessage("ml", "paper", "someone-else", other.id, {
      role: "user",
      content: "secret",
      at: "2026-08-10T10:00:00.000Z",
    });
    const response = await callDelete(other.id, {
      index: 0,
      at: "2026-08-10T10:00:00.000Z",
    });
    expect(response.status).toBe(409);
    expect(
      chats.readChat("ml", "paper", "someone-else", other.id)?.messages,
    ).toHaveLength(1);
  });
});
