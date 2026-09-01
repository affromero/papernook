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

describe("citations match route by url", () => {
  async function placeSource(
    topic: string | null,
    slug: string,
    title: string,
    sourceUrl: string,
    arxivId: string | null,
  ): Promise<void> {
    const papers = await import("@/lib/library/papers");
    papers.writeMeta(topic, slug, { ...meta(title), sourceUrl, arxivId });
    papers.writeText(topic, slug, "");
    const pdf = papers.pdfPath(topic, slug);
    fs.mkdirSync(path.dirname(pdf), { recursive: true });
    fs.writeFileSync(pdf, "%PDF-1.4");
  }

  const matchUrl = (query: string) =>
    new NextRequest(`http://localhost/api/v1/citations/match?${query}`);

  it("resolves a cited arXiv or publisher link to a confirmed paper", async () => {
    await placeSource(
      "ml",
      "splatting",
      "3D Gaussian Splatting",
      "https://arxiv.org/abs/2308.04079",
      "2308.04079v1",
    );
    await placeSource(
      "ml",
      "nerf-book",
      "Neural Fields",
      "https://publisher.example/article/42",
      null,
    );
    signedIn(true);
    const route = await import("@/app/api/v1/citations/match/route");

    const versioned = await route.GET(
      matchUrl(
        `url=${encodeURIComponent("https://arxiv.org/pdf/2308.04079v2")}`,
      ),
    );
    expect(await versioned.json()).toEqual({
      match: { topic: "ml", slug: "splatting", title: "3D Gaussian Splatting" },
    });

    const publisher = await route.GET(
      matchUrl(
        `url=${encodeURIComponent("https://publisher.example/article/42")}`,
      ),
    );
    expect(
      ((await publisher.json()) as { match: { slug: string } }).match.slug,
    ).toBe("nerf-book");

    const miss = await route.GET(
      matchUrl(`url=${encodeURIComponent("https://arxiv.org/abs/1706.03762")}`),
    );
    expect(await miss.json()).toEqual({ match: null });
  });

  it("never reveals an inbox paper, even the caller's own", async () => {
    await placeSource(
      null,
      "pending",
      "Pending Splatting",
      "https://arxiv.org/abs/2308.04079",
      "2308.04079",
    );
    signedIn(true);
    const route = await import("@/app/api/v1/citations/match/route");
    const response = await route.GET(
      matchUrl(`url=${encodeURIComponent("https://arxiv.org/abs/2308.04079")}`),
    );
    expect(await response.json()).toEqual({ match: null });
  });

  it("still resolves bibliography text through q and rejects malformed lookups", async () => {
    await place("ml", "splatting", "3D Gaussian Splatting for Radiance Fields");
    const { rebuildIndex } = await import("@/lib/library/index-db");
    rebuildIndex();
    signedIn(true);
    const route = await import("@/app/api/v1/citations/match/route");

    const hit = await route.GET(
      matchUrl(
        `q=${encodeURIComponent(
          "Kerbl, B.: 3D Gaussian splatting for radiance fields. TOG (2023)",
        )}`,
      ),
    );
    expect(((await hit.json()) as { match: { slug: string } }).match.slug).toBe(
      "splatting",
    );

    expect((await route.GET(matchUrl(""))).status).toBe(400);
    expect(
      (
        await route.GET(
          matchUrl(
            `q=${encodeURIComponent("Kerbl, B.: 3D Gaussian splatting (2023)")}&url=${encodeURIComponent("https://arxiv.org/abs/2308.04079")}`,
          ),
        )
      ).status,
    ).toBe(400);
    expect((await route.GET(matchUrl("url=not-a-url"))).status).toBe(400);
    expect(
      (
        await route.GET(
          matchUrl(`url=${"https://x.example/".padEnd(2010, "a")}`),
        )
      ).status,
    ).toBe(400);

    signedIn(false);
    vi.resetModules();
    const anonymous = await import("@/app/api/v1/citations/match/route");
    expect(
      (
        await anonymous.GET(
          matchUrl(
            `url=${encodeURIComponent("https://arxiv.org/abs/2308.04079")}`,
          ),
        )
      ).status,
    ).toBe(401);
  });
});

describe("citations resolve route", () => {
  const resolveUrl = (query: string) =>
    new NextRequest(`http://localhost/api/v1/citations/resolve?${query}`);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves an entry to a capturable URL for signed-in readers only", async () => {
    vi.stubGlobal("fetch", async () => new Response("<feed></feed>"));
    signedIn(true);
    const route = await import("@/app/api/v1/citations/resolve/route");
    const hit = await route.GET(
      resolveUrl(
        `q=${encodeURIComponent("Kerbl, B.: 3D Gaussian splatting. arXiv:2308.04079 (2023)")}`,
      ),
    );
    expect(hit.status).toBe(200);
    expect(await hit.json()).toEqual({
      url: "https://arxiv.org/abs/2308.04079",
      title: null,
    });

    const miss = await route.GET(
      resolveUrl(
        `q=${encodeURIComponent("Doe, A., Roe, B. Robust estimation of planar homographies. IJCV (2011)")}`,
      ),
    );
    expect(await miss.json()).toEqual({ url: null });

    // An upstream outage is a retryable failure, never a "not found".
    vi.stubGlobal("fetch", async () => new Response("", { status: 503 }));
    const outage = await route.GET(
      resolveUrl(
        `q=${encodeURIComponent("Roe, B., Doe, A. Dense estimation of camera motion. CVPR (2012)")}`,
      ),
    );
    expect(outage.status).toBe(502);

    expect((await route.GET(resolveUrl(""))).status).toBe(400);
    expect((await route.GET(resolveUrl("q=too+short"))).status).toBe(400);
    expect((await route.GET(resolveUrl(`q=${"x".repeat(401)}`))).status).toBe(
      400,
    );

    signedIn(false);
    vi.resetModules();
    const anonymous = await import("@/app/api/v1/citations/resolve/route");
    expect(
      (
        await anonymous.GET(
          resolveUrl(`q=${encodeURIComponent("arXiv:2308.04079 (2023)")}`),
        )
      ).status,
    ).toBe(401);
  });

  it("throttles a reader after 60 lookups in ten minutes", async () => {
    signedIn(true);
    const route = await import("@/app/api/v1/citations/resolve/route");
    let last = 0;
    for (let i = 0; i < 61; i++) {
      last = (
        await route.GET(
          resolveUrl(
            `q=${encodeURIComponent(`arXiv:2308.0${4000 + i} (2023)`)}`,
          ),
        )
      ).status;
    }
    expect(last).toBe(429);
  });
});
