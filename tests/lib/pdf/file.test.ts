import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { PDFDocument } from "pdf-lib";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-pdf-file-"));
  process.env.PAPERNOOK_DATA_DIR = tmpDir;
  process.env.SESSION_SECRET = "s".repeat(64);
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("@/lib/auth/session");
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function makePdf(label: string): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([400, 600]);
  page.drawText(label, { x: 40, y: 540 });
  return document.save();
}

async function placePaper(): Promise<string> {
  const { ensureDataDirs } = await import("@/lib/data-dir");
  const papers = await import("@/lib/library/papers");
  ensureDataDirs();
  papers.writeMeta("nlp", "attention", {
    title: "Attention",
    authors: [],
    year: 2017,
    venue: null,
    arxivId: null,
    bibtex: null,
    tags: [],
    related: [],
    sourceUrl: "https://example.test/attention.pdf",
    addedAt: new Date().toISOString(),
    addedBy: "andres",
  });
  const pdfPath = papers.pdfPath("nlp", "attention");
  fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
  fs.writeFileSync(pdfPath, await makePdf("original"));
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(pdfPath, old, old);
  return pdfPath;
}

async function signedInAs(username: string | null): Promise<void> {
  vi.doMock("@/lib/auth/session", () => ({
    activeProfile: async () => {
      if (!username) return null;
      const { getProfile } = await import("@/lib/auth/users");
      return getProfile(username);
    },
  }));
}

describe("versioned PDF files", () => {
  it("atomically replaces the expected PDF and returns its new version", async () => {
    const pdfPath = await placePaper();
    const { pdfEtag, readVersionedPdf, replacePdf } =
      await import("@/lib/library/pdf/file");
    const opened = await readVersionedPdf("nlp", "attention");
    const annotated = await makePdf("annotated");

    const saved = await replacePdf("nlp", "attention", opened!.etag, annotated);

    expect(saved.etag).toBe(pdfEtag(annotated));
    expect(await PDFDocument.load(fs.readFileSync(pdfPath))).toBeInstanceOf(
      PDFDocument,
    );
    expect(
      fs
        .readdirSync(path.dirname(pdfPath))
        .some((name) => name.endsWith(".tmp")),
    ).toBe(false);
  });

  it("rejects a PDF truncated in transit and keeps the file intact", async () => {
    const pdfPath = await placePaper();
    const before = fs.readFileSync(pdfPath);
    const { InvalidPdfError, readVersionedPdf, replacePdf } =
      await import("@/lib/library/pdf/file");
    const opened = await readVersionedPdf("nlp", "attention");
    const annotated = await makePdf("annotated");
    const truncated = annotated.subarray(
      0,
      Math.floor(annotated.byteLength / 2),
    );

    await expect(
      replacePdf("nlp", "attention", opened!.etag, truncated),
    ).rejects.toThrow(InvalidPdfError);
    expect(fs.readFileSync(pdfPath)).toEqual(before);
  });

  it("never overwrites a PDF changed after the reader opened it", async () => {
    const pdfPath = await placePaper();
    const { PdfConflictError, readVersionedPdf, replacePdf } =
      await import("@/lib/library/pdf/file");
    const opened = await readVersionedPdf("nlp", "attention");
    const external = await makePdf("new Pencil ink");
    fs.writeFileSync(pdfPath, external);

    await expect(
      replacePdf(
        "nlp",
        "attention",
        opened!.etag,
        await makePdf("stale browser edit"),
      ),
    ).rejects.toThrow(PdfConflictError);
    expect(fs.readFileSync(pdfPath)).toEqual(Buffer.from(external));
  });
});

describe("authenticated PDF route", () => {
  it("reports the current version without returning the PDF body", async () => {
    const pdfPath = await placePaper();
    const users = await import("@/lib/auth/users");
    users.createProfile("Andres");
    await signedInAs("andres");
    const route = await import("@/app/api/v1/papers/[topic]/[slug]/pdf/route");
    const params = {
      params: Promise.resolve({ topic: "nlp", slug: "attention" }),
    };
    const request = new NextRequest(
      "http://localhost/api/v1/papers/nlp/attention/pdf",
      { method: "HEAD" },
    );

    const opened = await route.GET(request, params);
    const unchanged = await route.HEAD(request, params);

    expect(unchanged.status).toBe(200);
    expect(unchanged.headers.get("etag")).toBe(opened.headers.get("etag"));
    expect(await unchanged.text()).toBe("");

    fs.writeFileSync(pdfPath, await makePdf("external Pencil edit"));
    expect((await route.HEAD(request, params)).status).toBe(409);

    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(pdfPath, old, old);
    const changed = await route.HEAD(request, params);
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(opened.headers.get("etag"));
  });

  it("requires a signed-in profile to check a PDF version", async () => {
    await placePaper();
    await signedInAs(null);
    const route = await import("@/app/api/v1/papers/[topic]/[slug]/pdf/route");
    const response = await route.HEAD(
      new NextRequest("http://localhost/api/v1/papers/nlp/attention/pdf", {
        method: "HEAD",
      }),
      { params: Promise.resolve({ topic: "nlp", slug: "attention" }) },
    );

    expect(response.status).toBe(401);
  });

  it("round-trips a native PDF save and rejects the stale version", async () => {
    await placePaper();
    const users = await import("@/lib/auth/users");
    users.createProfile("Andres");
    await signedInAs("andres");
    const route = await import("@/app/api/v1/papers/[topic]/[slug]/pdf/route");
    const params = {
      params: Promise.resolve({ topic: "nlp", slug: "attention" }),
    };

    const opened = await route.GET(
      new NextRequest("http://localhost/api/v1/papers/nlp/attention/pdf"),
      params,
    );
    const etag = opened.headers.get("etag");
    expect(opened.status).toBe(200);
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(opened.headers.get("cache-control")).toContain("no-store");

    const annotated = await makePdf("web annotation");
    const saved = await route.PUT(
      new NextRequest("http://localhost/api/v1/papers/nlp/attention/pdf", {
        method: "PUT",
        headers: {
          "content-type": "application/pdf",
          "if-match": etag!,
        },
        body: new Uint8Array(annotated).buffer,
      }),
      params,
    );
    expect(saved.status).toBe(200);
    const savedEtag = saved.headers.get("etag");
    expect(savedEtag).not.toBe(etag);

    const savedAgain = await route.PUT(
      new NextRequest("http://localhost/api/v1/papers/nlp/attention/pdf", {
        method: "PUT",
        headers: {
          "content-type": "application/pdf",
          "if-match": savedEtag!,
        },
        body: new Uint8Array(await makePdf("second web annotation")).buffer,
      }),
      params,
    );
    expect(savedAgain.status).toBe(200);

    const stale = await route.PUT(
      new NextRequest("http://localhost/api/v1/papers/nlp/attention/pdf", {
        method: "PUT",
        headers: {
          "content-type": "application/pdf",
          "if-match": etag!,
        },
        body: new Uint8Array(await makePdf("stale")).buffer,
      }),
      params,
    );
    expect(stale.status).toBe(412);
    expect(await stale.json()).toMatchObject({
      error: expect.stringContaining("Reload before saving"),
    });
  });

  it("rejects saves that arrive truncated instead of writing them", async () => {
    const pdfPath = await placePaper();
    const before = fs.readFileSync(pdfPath);
    const users = await import("@/lib/auth/users");
    users.createProfile("Andres");
    await signedInAs("andres");
    const route = await import("@/app/api/v1/papers/[topic]/[slug]/pdf/route");
    const params = {
      params: Promise.resolve({ topic: "nlp", slug: "attention" }),
    };
    const etag = (
      await route.GET(
        new NextRequest("http://localhost/api/v1/papers/nlp/attention/pdf"),
        params,
      )
    ).headers.get("etag");
    const annotated = await makePdf("web annotation");

    // Body cut off mid-stream: the PDF trailer never arrives.
    const cutOff = await route.PUT(
      new NextRequest("http://localhost/api/v1/papers/nlp/attention/pdf", {
        method: "PUT",
        headers: { "content-type": "application/pdf", "if-match": etag! },
        body: annotated.slice(0, Math.floor(annotated.byteLength / 2))
          .buffer as ArrayBuffer,
      }),
      params,
    );
    expect(cutOff.status).toBe(422);

    // Intact body but shorter than the length the client declared.
    const shortened = await route.PUT(
      new NextRequest("http://localhost/api/v1/papers/nlp/attention/pdf", {
        method: "PUT",
        headers: {
          "content-type": "application/pdf",
          "if-match": etag!,
          "content-length": String(annotated.byteLength * 2),
        },
        body: new Uint8Array(annotated).buffer,
      }),
      params,
    );
    expect(shortened.status).toBe(422);
    expect(await shortened.json()).toMatchObject({
      error: expect.stringContaining("incomplete"),
    });
    expect(fs.readFileSync(pdfPath)).toEqual(before);
  });

  it("requires a signed-in profile, PDF content type, and opened version", async () => {
    await placePaper();
    await signedInAs(null);
    let route = await import("@/app/api/v1/papers/[topic]/[slug]/pdf/route");
    const params = {
      params: Promise.resolve({ topic: "nlp", slug: "attention" }),
    };
    const request = () =>
      new NextRequest("http://localhost/api/v1/papers/nlp/attention/pdf", {
        method: "PUT",
        body: "not a PDF",
      });
    expect((await route.PUT(request(), params)).status).toBe(401);

    vi.resetModules();
    const users = await import("@/lib/auth/users");
    users.createProfile("Andres");
    await signedInAs("andres");
    route = await import("@/app/api/v1/papers/[topic]/[slug]/pdf/route");
    expect((await route.PUT(request(), params)).status).toBe(400);
  });
});
