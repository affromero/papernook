import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import type { Bibliography } from "@/lib/pdf/bibliography";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-bib-"));
  process.env.PAPERNOOK_DATA_DIR = tmpDir;
  vi.resetModules();
});

afterEach(async () => {
  vi.doUnmock("@/lib/auth/session");
  const { closeIndex } = await import("@/lib/library/index-db");
  closeIndex();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function bibliography(): Bibliography {
  return {
    style: "numbered",
    entries: [
      {
        pageNumber: 9,
        x: 40,
        y: 700,
        text: "[20] Kheradmand et al. 3D Gaussian Splatting as MCMC. 2024.",
        surname: "Kheradmand",
        year: "2024",
        suffix: null,
        number: 20,
      },
    ],
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

function signedIn(active: boolean): void {
  vi.doMock("@/lib/auth/session", () => ({
    activeProfile: async () => (active ? { username: "andres" } : null),
  }));
}

const routeParams = (topic: string, slug: string) => ({
  params: Promise.resolve({ topic, slug }),
});

function putRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/bibliography", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("bibliography store", () => {
  it("round-trips a written bibliography", async () => {
    const store = await import("@/lib/library/bibliography/store");
    const bib = bibliography();
    store.writeBibliography("ml", "paper", bib);
    expect(store.readBibliography("ml", "paper")).toEqual(bib);
  });

  it("returns null when the file is absent, corrupt, or invalid", async () => {
    const store = await import("@/lib/library/bibliography/store");
    expect(store.readBibliography("ml", "paper")).toBeNull();

    const file = store.bibliographyPath("ml", "paper");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json");
    expect(store.readBibliography("ml", "paper")).toBeNull();

    // Schema violations: unknown keys, oversize entry text, and an empty
    // entries array (which would suppress the graph's text heuristic) all
    // reject.
    const bib = bibliography();
    fs.writeFileSync(file, JSON.stringify({ ...bib, extra: true }));
    expect(store.readBibliography("ml", "paper")).toBeNull();
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...bib,
        entries: [
          {
            ...bib.entries[0],
            text: "x".repeat(store.MAX_STORED_ENTRY_TEXT + 1),
          },
        ],
      }),
    );
    expect(store.readBibliography("ml", "paper")).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ ...bib, entries: [] }));
    expect(store.readBibliography("ml", "paper")).toBeNull();
  });

  it("writes atomically, leaving no tmp file behind", async () => {
    const store = await import("@/lib/library/bibliography/store");
    store.writeBibliography("ml", "paper", bibliography());
    const dir = path.dirname(store.bibliographyPath("ml", "paper"));
    expect(fs.readdirSync(dir).filter((name) => name.includes(".tmp"))).toEqual(
      [],
    );
  });

  it("keeps the previous bibliography intact when a write fails", async () => {
    const store = await import("@/lib/library/bibliography/store");
    const original = bibliography();
    store.writeBibliography("ml", "paper", original);
    // Fail the atomic rename mid-write: the stored file must be untouched.
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    const changed = {
      ...original,
      entries: [{ ...original.entries[0], text: "partial overwrite" }],
    };
    expect(() => store.writeBibliography("ml", "paper", changed)).toThrow();
    rename.mockRestore();
    expect(store.readBibliography("ml", "paper")).toEqual(original);
  });
});

describe("bibliography route", () => {
  it("requires a session", async () => {
    signedIn(false);
    const route =
      await import("@/app/api/v1/papers/[topic]/[slug]/bibliography/route");
    expect(
      (
        await route.GET(
          new NextRequest("http://localhost/bibliography"),
          routeParams("ml", "paper"),
        )
      ).status,
    ).toBe(401);
    expect(
      (await route.PUT(putRequest(bibliography()), routeParams("ml", "paper")))
        .status,
    ).toBe(401);
  });

  it("404s for an unknown paper and 400s for bad params", async () => {
    signedIn(true);
    const route =
      await import("@/app/api/v1/papers/[topic]/[slug]/bibliography/route");
    expect(
      (
        await route.GET(
          new NextRequest("http://localhost/bibliography"),
          routeParams("ml", "missing"),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await route.GET(
          new NextRequest("http://localhost/bibliography"),
          routeParams("..", "escape"),
        )
      ).status,
    ).toBe(400);
  });

  it("PUT stores and GET returns the bibliography", async () => {
    await placePaper("ml", "paper");
    signedIn(true);
    const route =
      await import("@/app/api/v1/papers/[topic]/[slug]/bibliography/route");

    const before = await route.GET(
      new NextRequest("http://localhost/bibliography"),
      routeParams("ml", "paper"),
    );
    expect(await before.json()).toEqual({ bibliography: null });

    const bib = bibliography();
    const put = await route.PUT(putRequest(bib), routeParams("ml", "paper"));
    expect(put.status).toBe(200);

    const after = await route.GET(
      new NextRequest("http://localhost/bibliography"),
      routeParams("ml", "paper"),
    );
    expect(await after.json()).toEqual({ bibliography: bib });
  });

  it("rejects an invalid body", async () => {
    await placePaper("ml", "paper");
    signedIn(true);
    const route =
      await import("@/app/api/v1/papers/[topic]/[slug]/bibliography/route");
    expect(
      (
        await route.PUT(
          putRequest({ style: "roman", entries: [] }),
          routeParams("ml", "paper"),
        )
      ).status,
    ).toBe(400);
    expect(
      (await route.PUT(putRequest(null), routeParams("ml", "paper"))).status,
    ).toBe(400);
  });

  it("throttles repeated writes", async () => {
    await placePaper("ml", "paper");
    signedIn(true);
    const route =
      await import("@/app/api/v1/papers/[topic]/[slug]/bibliography/route");
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      statuses.push(
        (
          await route.PUT(
            putRequest(bibliography()),
            routeParams("ml", "paper"),
          )
        ).status,
      );
    }
    expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});
