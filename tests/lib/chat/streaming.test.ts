import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

let tmpDir: string;
let releaseProvider: () => void;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-chat-stream-"));
  process.env.PAPERNOOK_DATA_DIR = tmpDir;
  vi.resetModules();
  vi.doMock("@/lib/auth/session", () => ({
    activeProfile: async () => ({ username: "andres" }),
  }));
  vi.doMock("@/lib/agent/registry", () => ({
    hasConfiguredProvider: () => true,
    getProvider: () => ({
      id: "claude-code",
      capabilities: { web: true, vision: true, unboundedContext: true },
      execute: async () => "answer",
      stream: async function* () {
        await new Promise<void>((resolve) => {
          releaseProvider = resolve;
        });
        yield "answer";
      },
    }),
  }));

  const papers = await import("@/lib/library/papers");
  papers.writeMeta("ml", "paper", {
    title: "Paper",
    authors: [],
    year: null,
    venue: null,
    arxivId: null,
    bibtex: null,
    tags: [],
    related: [],
    sourceUrl: "https://example.test/paper.pdf",
    addedAt: new Date().toISOString(),
    addedBy: "andres",
  });
  const pdf = papers.pdfPath("ml", "paper");
  fs.mkdirSync(path.dirname(pdf), { recursive: true });
  fs.writeFileSync(pdf, "%PDF-1.4");
});

afterEach(async () => {
  vi.doUnmock("@/lib/auth/session");
  vi.doUnmock("@/lib/agent/registry");
  const { closeIndex } = await import("@/lib/library/index-db");
  closeIndex();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("chat response streaming", () => {
  it("sends a keepalive before a slow provider responds without persisting it", async () => {
    const chats = await import("@/lib/library/chats");
    const chat = chats.createChat("ml", "paper", "andres", "Slow chat");
    const route =
      await import("@/app/api/v1/papers/[topic]/[slug]/chats/[chatId]/route");
    const response = await route.POST(
      new NextRequest("http://localhost/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "research this" }),
      }),
      {
        params: Promise.resolve({
          topic: "ml",
          slug: "paper",
          chatId: chat.id,
        }),
      },
    );

    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("\n");
    expect(first.done).toBe(false);

    releaseProvider();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe("answer");
    expect((await reader.read()).done).toBe(true);

    const stored = chats.readChat("ml", "paper", "andres", chat.id);
    expect(stored?.messages).toEqual([
      expect.objectContaining({ role: "user", content: "research this" }),
      expect.objectContaining({ role: "assistant", content: "answer" }),
    ]);
  });

  it("does not recreate a chat deleted while the provider is responding", async () => {
    const chats = await import("@/lib/library/chats");
    const chat = chats.createChat("ml", "paper", "andres", "Slow chat");
    const route =
      await import("@/app/api/v1/papers/[topic]/[slug]/chats/[chatId]/route");
    const response = await route.POST(
      new NextRequest("http://localhost/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "research this" }),
      }),
      {
        params: Promise.resolve({
          topic: "ml",
          slug: "paper",
          chatId: chat.id,
        }),
      },
    );

    const reader = response.body!.getReader();
    await reader.read();
    expect(chats.deleteChat("ml", "paper", "andres", chat.id)).toBe(true);
    releaseProvider();
    while (!(await reader.read()).done) {
      // Drain the streamed answer so assistant persistence runs.
    }

    expect(chats.readChat("ml", "paper", "andres", chat.id)).toBeNull();
    expect(chats.listChats("ml", "paper", "andres")).toEqual([]);
  });
});
