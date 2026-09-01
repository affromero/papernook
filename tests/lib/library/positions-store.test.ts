import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import type { ReadingPosition } from "@/lib/pdf/view/reading-position";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-pos-"));
  process.env.PAPERNOOK_DATA_DIR = tmpDir;
  vi.resetModules();
});

afterEach(async () => {
  vi.doUnmock("@/lib/auth/session");
  const { closeIndex } = await import("@/lib/library/index-db");
  closeIndex();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function position(overrides: Partial<ReadingPosition> = {}): ReadingPosition {
  return {
    page: 7,
    scale: 1.25,
    updatedAt: 1_756_600_000_000,
    viewport: 900,
    ...overrides,
  };
}

async function placePaper(topic: string, slug: string): Promise<void> {
  const papers = await import("@/lib/library/papers");
  papers.writeMeta(topic, slug, {
    title: "A Paper",
    authors: ["Ada Lovelace"],
    year: 2024,
    venue: null,
    arxivId: null,
    bibtex: null,
    tags: [],
    related: [],
    sourceUrl: "https://example.com/paper.pdf",
    addedAt: new Date().toISOString(),
    addedBy: "andres",
  });
  const pdf = papers.pdfPath(topic, slug);
  fs.mkdirSync(path.dirname(pdf), { recursive: true });
  fs.writeFileSync(pdf, "%PDF-1.4 fake");
}

function signedInAs(username: string | null): void {
  vi.doMock("@/lib/auth/session", () => ({
    activeProfile: async () => (username ? { username } : null),
  }));
}

const routeParams = (topic: string, slug: string) => ({
  params: Promise.resolve({ topic, slug }),
});

function putRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/position", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("positions store", () => {
  it("round-trips a written position", async () => {
    const store = await import("@/lib/library/positions/store");
    const pos = position();
    store.writePosition("ml", "paper", "andres", pos);
    expect(store.readPosition("ml", "paper", "andres")).toEqual(pos);
  });

  it("keeps each profile's position separate", async () => {
    const store = await import("@/lib/library/positions/store");
    store.writePosition("ml", "paper", "andres", position({ page: 3 }));
    store.writePosition("ml", "paper", "guest", position({ page: 11 }));
    expect(store.readPosition("ml", "paper", "andres")?.page).toBe(3);
    expect(store.readPosition("ml", "paper", "guest")?.page).toBe(11);
  });

  it("returns null when the file is absent, corrupt, or invalid", async () => {
    const store = await import("@/lib/library/positions/store");
    expect(store.readPosition("ml", "paper", "andres")).toBeNull();

    const file = store.positionPath("ml", "paper", "andres");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json");
    expect(store.readPosition("ml", "paper", "andres")).toBeNull();

    // Schema violations: unknown keys, a fractional page, an out-of-range
    // zoom, a missing timestamp, and a far-future timestamp (which would
    // otherwise win every freshness race forever) all reject.
    for (const invalid of [
      { ...position(), extra: true },
      position({ page: 2.5 }),
      position({ scale: 100 }),
      { page: 7, scale: 1.25 },
      position({ updatedAt: 1e300 }),
    ]) {
      fs.writeFileSync(file, JSON.stringify(invalid));
      expect(store.readPosition("ml", "paper", "andres")).toBeNull();
    }
  });

  it("refuses a username that is not a slug", async () => {
    const store = await import("@/lib/library/positions/store");
    expect(() =>
      store.writePosition("ml", "paper", "../escape", position()),
    ).toThrow(/slug/i);
    expect(() => store.readPosition("ml", "paper", "UPPER")).toThrow(/slug/i);
  });

  it("writes atomically, leaving no tmp file behind", async () => {
    const store = await import("@/lib/library/positions/store");
    store.writePosition("ml", "paper", "andres", position());
    const dir = path.dirname(store.positionPath("ml", "paper", "andres"));
    expect(fs.readdirSync(dir).filter((name) => name.includes(".tmp"))).toEqual(
      [],
    );
  });
});

describe("position route", () => {
  it("requires a session", async () => {
    signedInAs(null);
    const route =
      await import("@/app/api/v1/papers/[topic]/[slug]/position/route");
    expect(
      (
        await route.GET(
          new NextRequest("http://localhost/position"),
          routeParams("ml", "paper"),
        )
      ).status,
    ).toBe(401);
    expect(
      (await route.PUT(putRequest(position()), routeParams("ml", "paper")))
        .status,
    ).toBe(401);
  });

  it("404s for an unknown paper and 400s for bad params", async () => {
    signedInAs("andres");
    const route =
      await import("@/app/api/v1/papers/[topic]/[slug]/position/route");
    expect(
      (
        await route.GET(
          new NextRequest("http://localhost/position"),
          routeParams("ml", "missing"),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await route.GET(
          new NextRequest("http://localhost/position"),
          routeParams("..", "escape"),
        )
      ).status,
    ).toBe(400);
  });

  it("PUT stores and GET returns the profile's position", async () => {
    await placePaper("ml", "paper");
    signedInAs("andres");
    const route =
      await import("@/app/api/v1/papers/[topic]/[slug]/position/route");

    const before = await route.GET(
      new NextRequest("http://localhost/position"),
      routeParams("ml", "paper"),
    );
    expect(await before.json()).toEqual({ position: null });

    const pos = position();
    const put = await route.PUT(putRequest(pos), routeParams("ml", "paper"));
    expect(put.status).toBe(200);

    const after = await route.GET(
      new NextRequest("http://localhost/position"),
      routeParams("ml", "paper"),
    );
    expect(await after.json()).toEqual({ position: pos });
  });

  it("never shows one profile another profile's position", async () => {
    await placePaper("ml", "paper");
    signedInAs("andres");
    let route =
      await import("@/app/api/v1/papers/[topic]/[slug]/position/route");
    await route.PUT(
      putRequest(position({ page: 42 })),
      routeParams("ml", "paper"),
    );

    vi.doUnmock("@/lib/auth/session");
    signedInAs("guest");
    vi.resetModules();
    route = await import("@/app/api/v1/papers/[topic]/[slug]/position/route");
    const asGuest = await route.GET(
      new NextRequest("http://localhost/position"),
      routeParams("ml", "paper"),
    );
    expect(await asGuest.json()).toEqual({ position: null });
  });

  it("rejects an invalid body", async () => {
    await placePaper("ml", "paper");
    signedInAs("andres");
    const route =
      await import("@/app/api/v1/papers/[topic]/[slug]/position/route");
    for (const body of [
      { page: 0, scale: 1, updatedAt: 0 },
      { page: 1, scale: 1 },
      { ...position(), extra: true },
      position({ updatedAt: 1e300 }),
      "half way",
    ]) {
      expect(
        (await route.PUT(putRequest(body), routeParams("ml", "paper"))).status,
      ).toBe(400);
    }
  });
});
