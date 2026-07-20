import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-canvas-"));
  process.env.PAPERNOOK_DATA_DIR = tmpDir;
  vi.resetModules();
  vi.doMock("@/lib/auth/session", () => ({
    activeProfile: async () => ({ username: "andres" }),
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

afterEach(() => {
  vi.doUnmock("@/lib/auth/session");
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const params = {
  params: Promise.resolve({ topic: "ml", slug: "paper" }),
};

describe("shared canvas persistence", () => {
  it("stores document state without session state and rejects stale saves", async () => {
    const route =
      await import("@/app/api/v1/papers/[topic]/[slug]/canvas/route");
    const initial = await route.GET(
      new NextRequest("http://localhost/canvas"),
      params,
    );
    expect(await initial.json()).toEqual({ document: null });
    expect(initial.headers.get("etag")).toBe('"empty"');
    expect(initial.headers.get("x-canvas-version")).toBe('"empty"');

    const saved = await route.PUT(
      new NextRequest("http://localhost/canvas", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Canvas-Version": '"empty"',
        },
        body: JSON.stringify({
          document: { store: { "shape:one": { typeName: "shape" } } },
        }),
      }),
      params,
    );
    expect(saved.status).toBe(200);
    expect(saved.headers.get("etag")).not.toBe('"empty"');
    expect(saved.headers.get("x-canvas-version")).toBe(
      saved.headers.get("etag"),
    );

    const stale = await route.PUT(
      new NextRequest("http://localhost/canvas", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Canvas-Version": '"empty"',
        },
        body: JSON.stringify({ document: { store: {} } }),
      }),
      params,
    );
    expect(stale.status).toBe(409);
    expect(stale.headers.get("x-canvas-version")).toBe(
      saved.headers.get("etag"),
    );

    const reloaded = await route.GET(
      new NextRequest("http://localhost/canvas"),
      params,
    );
    const reloadedPayload = await reloaded.json();
    expect(reloadedPayload).toEqual({
      document: { store: { "shape:one": { typeName: "shape" } } },
    });
    expect(JSON.stringify(reloadedPayload)).not.toContain("session");
    expect(reloaded.headers.get("x-canvas-version")).toBe(
      saved.headers.get("etag"),
    );
  });

  it("prefers the canonical canvas version and retains If-Match compatibility", async () => {
    const route =
      await import("@/app/api/v1/papers/[topic]/[slug]/canvas/route");
    const first = await route.PUT(
      new NextRequest("http://localhost/canvas", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Canvas-Version": '"empty"',
          "If-Match": '"empty-gzip"',
        },
        body: JSON.stringify({ document: { store: {} } }),
      }),
      params,
    );
    expect(first.status).toBe(200);
    const firstVersion = first.headers.get("x-canvas-version");
    expect(firstVersion).toBeTruthy();

    const compatible = await route.PUT(
      new NextRequest("http://localhost/canvas", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "If-Match": firstVersion!,
        },
        body: JSON.stringify({
          document: { store: { "shape:two": { typeName: "shape" } } },
        }),
      }),
      params,
    );
    expect(compatible.status).toBe(200);
  });

  it("stores uploaded canvas images outside canvas.json and serves them", async () => {
    const assets =
      await import("@/app/api/v1/papers/[topic]/[slug]/canvas/assets/route");
    const uploaded = await assets.POST(
      new NextRequest("http://localhost/assets", {
        method: "POST",
        headers: { "Content-Type": "image/png" },
        body: Buffer.from("png bytes"),
      }),
      params,
    );
    expect(uploaded.status).toBe(200);
    const payload = (await uploaded.json()) as { src: string };
    const filename = payload.src.split("/").at(-1);
    expect(filename).toMatch(/\.png$/);

    const assetRoute =
      await import("@/app/api/v1/papers/[topic]/[slug]/canvas/assets/[asset]/route");
    const response = await assetRoute.GET(
      new NextRequest(`http://localhost${payload.src}`),
      {
        params: Promise.resolve({
          topic: "ml",
          slug: "paper",
          asset: filename!,
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe(
      "png bytes",
    );
  });

  it("rejects oversized canvas assets before reading their body", async () => {
    const assets =
      await import("@/app/api/v1/papers/[topic]/[slug]/canvas/assets/route");
    const response = await assets.POST(
      new NextRequest("http://localhost/assets", {
        method: "POST",
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(51 * 1024 * 1024),
        },
        body: Buffer.from("small declared-as-oversized body"),
      }),
      params,
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "Canvas assets must be between 1 byte and 50 MB.",
    });
  });

  it("surfaces a corrupt saved canvas instead of overwriting it", async () => {
    const papers = await import("@/lib/library/papers");
    const paper = papers.getPaper("ml", "paper");
    fs.writeFileSync(path.join(paper!.companionDir, "canvas.json"), "{broken");
    const route =
      await import("@/app/api/v1/papers/[topic]/[slug]/canvas/route");
    const response = await route.GET(
      new NextRequest("http://localhost/canvas"),
      params,
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "The saved canvas is invalid.",
    });
    expect(
      fs.readFileSync(path.join(paper!.companionDir, "canvas.json"), "utf8"),
    ).toBe("{broken");
  });
});
