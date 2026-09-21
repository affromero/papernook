import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { createTestProfile, mockTestSession } from "../../helpers/access";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-noai-"));
  process.env.PAPERNOOK_DATA_DIR = tmpDir;
  vi.resetModules();
  await createTestProfile("Andres");
  await mockTestSession("andres");
  vi.stubEnv("AI_PROVIDER", "");
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
  vi.doUnmock("next/headers");
  vi.unstubAllEnvs();
  const { closeIndex } = await import("@/lib/library/index-db");
  closeIndex();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("AI-only routes without a configured provider", () => {
  it("chat send returns 409 with a setup hint instead of streaming", async () => {
    const chats = await import("@/lib/library/chats");
    const chat = chats.createChat("ml", "paper", "andres", "First chat");
    const route =
      await import("@/app/api/v1/papers/[topic]/[slug]/chats/[chatId]/route");
    const response = await route.POST(
      new NextRequest("http://localhost/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "hello?" }),
      }),
      {
        params: Promise.resolve({
          topic: "ml",
          slug: "paper",
          chatId: chat.id,
        }),
      },
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/provider/i);
    // The user turn must not be persisted when the send is rejected.
    const stored = chats.readChat("ml", "paper", "andres", chat.id);
    expect(stored?.messages).toHaveLength(0);
  });

  it("discover returns 409 instead of a 502", async () => {
    const route = await import("@/app/api/v1/discover/route");
    const response = await route.POST(
      new NextRequest("http://localhost/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/provider/i);
  });
});
