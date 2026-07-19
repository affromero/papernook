import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import type { PaperMeta } from "@/lib/library/papers";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-cite-"));
  process.env.PAPERNOOK_DATA_DIR = tmpDir;
  vi.resetModules();
});

afterEach(async () => {
  vi.doUnmock("@/lib/auth/session");
  const { closeIndex } = await import("@/lib/library/index-db");
  closeIndex();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function meta(title: string, tags: string[] = []): PaperMeta {
  return {
    title,
    authors: ["Ada Lovelace"],
    year: 1843,
    venue: "Examples",
    arxivId: null,
    bibtex: null,
    tags,
    related: [],
    sourceUrl: "https://example.org",
    addedAt: "2024-01-01T00:00:00.000Z",
    addedBy: "andres",
  };
}

async function place(
  topic: string | null,
  slug: string,
  title: string,
  tags: string[] = [],
  text = "",
): Promise<void> {
  const papers = await import("@/lib/library/papers");
  papers.writeMeta(topic, slug, meta(title, tags));
  papers.writeText(topic, slug, text);
  const pdf = papers.pdfPath(topic, slug);
  fs.mkdirSync(path.dirname(pdf), { recursive: true });
  fs.writeFileSync(pdf, "%PDF-1.4");
}

function signedIn(active: boolean): void {
  vi.doMock("@/lib/auth/session", () => ({
    activeProfile: async () => (active ? { username: "andres" } : null),
  }));
}

describe("citation routes", () => {
  it("requires authentication and validates formats", async () => {
    signedIn(false);
    const paperRoute =
      await import("@/app/api/v1/papers/[topic]/[slug]/citation/route");
    expect(
      (
        await paperRoute.GET(
          new NextRequest("http://localhost/citation?format=ris"),
          { params: Promise.resolve({ topic: "ml", slug: "paper" }) },
        )
      ).status,
    ).toBe(401);

    vi.doUnmock("@/lib/auth/session");
    vi.resetModules();
    signedIn(true);
    const libraryRoute = await import("@/app/api/v1/citations/route");
    expect(
      (
        await libraryRoute.GET(
          new NextRequest("http://localhost/api/v1/citations?format=xml"),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await libraryRoute.GET(
          new NextRequest(
            `http://localhost/api/v1/citations?q=${"x".repeat(501)}`,
          ),
        )
      ).status,
    ).toBe(400);

    const paperRouteSignedIn =
      await import("@/app/api/v1/papers/[topic]/[slug]/citation/route");
    expect(
      (
        await paperRouteSignedIn.GET(
          new NextRequest("http://localhost/citation?format=ris"),
          {
            params: Promise.resolve({
              topic: "..",
              slug: "outside",
            }),
          },
        )
      ).status,
    ).toBe(400);
  });

  it("exports one known paper with safe download headers", async () => {
    await place("ml", "analytical-engine", "Analytical & Engine");
    signedIn(true);
    const route =
      await import("@/app/api/v1/papers/[topic]/[slug]/citation/route");
    const response = await route.GET(
      new NextRequest("http://localhost/citation?format=bibtex"),
      { params: Promise.resolve({ topic: "ml", slug: "analytical-engine" }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "application/x-bibtex",
    );
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="analytical-engine.bib"',
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toContain("Analytical \\& {Engine}");
  });

  it("exports exactly the visible confirmed filters and excludes inbox", async () => {
    await place(
      "history",
      "engine",
      "Analytical Engine",
      ["computing"],
      "transformer mechanism",
    );
    await place(
      "history",
      "notes",
      "Unrelated Notes",
      ["computing"],
      "different subject",
    );
    await place(null, "pending", "Pending Transformer", ["computing"]);
    signedIn(true);
    const route = await import("@/app/api/v1/citations/route");
    const response = await route.GET(
      new NextRequest(
        "http://localhost/api/v1/citations?format=csl-json&q=transformer&topic=history&tag=computing",
      ),
    );
    const body = (await response.json()) as { title: string }[];
    expect(body.map((record) => record.title)).toEqual(["Analytical Engine"]);

    const inbox = await route.GET(
      new NextRequest(
        "http://localhost/api/v1/citations?format=ris&topic=_inbox",
      ),
    );
    expect(inbox.status).toBe(400);
  });
});
