import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

// 8-byte PNG signature — passes the route's magic-byte check if it gets there.
const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-vision-gate-"));
  process.env.PAPERNOOK_DATA_DIR = tmpDir;
  vi.resetModules();
  vi.doMock("@/lib/auth/session", () => ({
    activeProfile: async () => ({ username: "andres" }),
  }));
  vi.doMock("@/lib/agent/registry", () => ({
    hasConfiguredProvider: () => true,
    getProvider: () => ({
      id: "claude-code",
      capabilities: { web: false, vision: false },
      execute: async () => "Figure explanation",
      stream: async function* () {
        throw new Error("stream must not run for a rejected image send");
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

async function postMessage(images?: string[]) {
  const chats = await import("@/lib/library/chats");
  const chat = chats.createChat("ml", "paper", "andres", chats.NEW_CHAT_TITLE);
  const route =
    await import("@/app/api/v1/papers/[topic]/[slug]/chats/[chatId]/route");
  const response = await route.POST(
    new NextRequest("http://localhost/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "explain this figure", images }),
    }),
    {
      params: Promise.resolve({ topic: "ml", slug: "paper", chatId: chat.id }),
    },
  );
  return { response, chatId: chat.id, chats };
}

describe("chat image sends on a provider without vision", () => {
  it("returns 400 before persisting the crop or the user turn", async () => {
    const { response, chatId, chats } = await postMessage([PNG_DATA_URL]);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/image/i);

    const papers = await import("@/lib/library/papers");
    const paper = papers.getPaper("ml", "paper");
    expect(paper).not.toBeNull();
    expect(fs.existsSync(path.join(paper!.companionDir, "crops"))).toBe(false);
    const stored = chats.readChat("ml", "paper", "andres", chatId);
    expect(stored?.messages).toHaveLength(0);
  });

  it("still accepts text-only sends", async () => {
    const { response, chatId, chats } = await postMessage();
    // The mocked stream throws, but the gate must not reject text sends.
    expect(response.status).toBe(200);
    await response.text();
    expect(chats.readChat("ml", "paper", "andres", chatId)?.header.title).toBe(
      "Figure explanation",
    );
  });
});
