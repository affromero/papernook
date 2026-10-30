import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  PDFDocument,
  PDFName,
  PDFString,
  PDFRawStream,
  PDFArray,
  decodePDFRawStream,
} from "pdf-lib";
import { fixture, post, annotated, annotationDetails } from "./fixture";
import {
  revokeTestProfile,
  createTestProfile,
  mockTestSession,
} from "../../helpers/access";

let directory: string;
beforeAll(() => {
  execFileSync(process.execPath, ["scripts/sharing/build.mjs"], {
    stdio: "pipe",
  });
});
beforeEach(() => {
  directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "papernook-collaboration-"),
  );
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  vi.resetModules();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("next/headers");
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("collaboration admission and authority", () => {
  it("bounds storage for pending withdrawals while permanently revoking approved departures", async () => {
    const f = await fixture();
    for (let index = 0; index < 40; index++) {
      const token = f.storage.newSecret();
      expect(
        (await post(f.share.id, token, "request", { name: "Visitor" })).status,
      ).toBe(200);
      expect((await post(f.share.id, token, "leave")).status).toBe(200);
    }
    expect(f.storage.readParticipants(f.share)).toHaveLength(1);
    expect(
      fs.existsSync(path.join(f.storage.collaborationDir(f.share), "revoked")),
    ).toBe(false);
    expect((await post(f.share.id, f.token, "leave")).status).toBe(200);
    expect(
      (
        await post(f.share.id, f.token, "request", {
          name: "Returning visitor",
        })
      ).status,
    ).toBe(403);
    expect(
      fs.readdirSync(path.join(f.storage.collaborationDir(f.share), "revoked")),
    ).toHaveLength(1);
  });
  it("applies request limits and browser-origin checks before reading exchange bodies", async () => {
    const f = await fixture();
    const { POST, GET } =
      await import("@/app/api/v1/shares/[topic]/[slug]/[shareId]/exchange/route");
    const context = {
      params: Promise.resolve({
        topic: "nlp",
        slug: "attention",
        shareId: f.share.id,
      }),
    };
    const crossSite = await POST(
      new Request("https://papers.example/exchange", {
        method: "POST",
        headers: {
          Origin: "https://attacker.example",
          Host: "papers.example",
          Authorization: `Bearer ${f.token}`,
        },
      }),
      context,
    );
    expect(crossSite.status).toBe(403);
    expect(crossSite.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    const unsupported = GET(new Request("https://papers.example/exchange"));
    expect(unsupported.status).toBe(405);
    expect(unsupported.headers.get("cache-control")).toContain("no-store");
    (await import("@/lib/auth/rate-limit")).resetRateLimits();
    vi.stubEnv("PAPERNOOK_PUBLIC_REQUEST_LIMIT", "1");
    expect((await post(f.share.id, f.token, "status")).status).toBe(200);
    const limited = await post(f.share.id, f.token, "status");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });
  it("rejects session-only editing without consuming an unfinished body", async () => {
    const f = await fixture();
    const { POST } =
      await import("@/app/api/v1/shares/[topic]/[slug]/[shareId]/exchange/route");
    const request = new Request("https://papers.example/exchange", {
      method: "POST",
      headers: {
        Cookie: "session=untrusted",
        "X-Sharing-Operation": "save-pdf",
      },
      body: new ReadableStream({ start() {} }),
      duplex: "half",
    } as RequestInit);
    const result = await POST(request, {
      params: Promise.resolve({
        topic: "nlp",
        slug: "attention",
        shareId: f.share.id,
      }),
    });
    expect(result.status).toBe(401);
    expect(request.bodyUsed).toBe(false);
  });
  it("keeps a revoked link denied if an old share record is restored", async () => {
    const f = await fixture();
    const directory = path.join(
      f.papers.companionDir("nlp", "attention"),
      "shares",
    );
    const file = path.join(directory, `${f.share.id}.json`);
    const saved = fs.readFileSync(file);
    f.shares.deleteShare("nlp", "attention", f.share.id, "ana");
    fs.writeFileSync(file, saved);
    expect((await post(f.share.id, f.token, "status")).status).toBe(404);
  });
  it("keeps public reading links incapable of authorizing edits", async () => {
    const f = await fixture("view");
    const original = fs.readFileSync(f.pdf);
    const response = await post(f.share.id, f.token, "save-pdf", {
      etag: '"' + "0".repeat(64) + '"',
      pdf: original.toString("base64"),
    });
    expect(response.status).toBe(404);
    expect(fs.readFileSync(f.pdf)).toEqual(original);
  });
  it("requires owner approval and binds names to the approved record", async () => {
    const f = await fixture();
    const token = f.storage.newSecret();
    const request = await post(f.share.id, token, "request", {
      name: "Someone claiming to be Ana",
    });
    expect(request.status).toBe(200);
    expect(await request.text()).not.toContain(token);
    expect((await post(f.share.id, token, "read")).status).toBe(403);
    await f.storage.withCollaboration(f.share, async () =>
      f.storage.setParticipant(
        f.share,
        f.storage.participantId(token),
        "approved",
        "Verified visitor",
      ),
    );
    expect((await post(f.share.id, token, "read")).status).toBe(200);
  });
  it("rejects cross-paper credentials and writes after participant or link revocation", async () => {
    const f = await fixture();
    const other = f.shares.createShare(
      "nlp",
      "attention",
      f.capability,
      [],
      "collaborate",
    );
    expect((await post(other.id, f.token, "read")).status).toBe(403);
    await f.storage.withCollaboration(f.share, async () =>
      f.storage.setParticipant(f.share, f.participant.id, "revoked"),
    );
    expect((await post(f.share.id, f.token, "read")).status).toBe(403);
    expect(
      (await post(f.share.id, f.token, "request", { name: "Maya again" }))
        .status,
    ).toBe(403);
    f.shares.deleteShare("nlp", "attention", f.share.id, "ana");
    expect(
      (await post(f.share.id, f.token, "request", { name: "Maya" })).status,
    ).toBe(404);
  });
  it("does not permit another local profile to approve participants", async () => {
    const f = await fixture();
    await createTestProfile("Bea");
    await mockTestSession("bea");
    const { PATCH } =
      await import("@/app/api/v1/papers/[topic]/[slug]/shares/[shareId]/participants/route");
    const response = await PATCH(
      new Request("http://localhost", {
        method: "PATCH",
        body: JSON.stringify({ id: f.participant.id, status: "revoked" }),
      }),
      {
        params: Promise.resolve({
          topic: "nlp",
          slug: "attention",
          shareId: f.share.id,
        }),
      },
    );
    expect(response.status).toBe(403);
    expect(f.storage.authenticateParticipant(f.share, f.token).name).toBe(
      "Maya Approved",
    );
  });
  it("revokes access immediately when the owning profile generation changes", async () => {
    const f = await fixture();
    await revokeTestProfile("ana");
    expect((await post(f.share.id, f.token, "read")).status).toBe(404);
  });
  it.each(["pdf", "read", "version", "changes"])(
    "does not disclose %s after owner revocation during a disk read",
    async (action) => {
      const f = await fixture();
      const read = fsPromises.readFile;
      let revoked = false;
      vi.spyOn(fsPromises, "readFile").mockImplementation(async (...args) => {
        const result = await read(...args);
        if (!revoked && String(args[0]) === f.pdf) {
          revoked = true;
          await revokeTestProfile("ana");
        }
        return result;
      });
      const result = await post(f.share.id, f.token, action);
      expect(revoked).toBe(true);
      expect(result.ok).toBe(false);
      expect(await result.text()).not.toContain("JVBER");
    },
  );
  it("frees pending capacity after expiry or rejection", async () => {
    const f = await fixture();
    for (let i = 0; i < 31; i++)
      f.storage.requestParticipant(
        f.share,
        f.storage.newSecret(),
        "Pending visitor",
      );
    const token = f.storage.newSecret();
    expect(() =>
      f.storage.requestParticipant(f.share, token, "Legitimate visitor"),
    ).toThrow();
    const pending = f.storage
      .readParticipants(f.share)
      .find((p) => p.status === "pending")!;
    f.storage.setParticipant(f.share, pending.id, "revoked");
    expect(
      f.storage.requestParticipant(f.share, token, "Legitimate visitor").status,
    ).toBe("pending");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 25 * 60 * 60_000);
    expect(
      f.storage.requestParticipant(
        f.share,
        f.storage.newSecret(),
        "Later visitor",
      ).status,
    ).toBe("pending");
    expect(
      f.storage.readParticipants(f.share).filter((p) => p.status === "pending"),
    ).toHaveLength(1);
  });
  it("rechecks participant approval after an admitted upload finishes", async () => {
    const f = await fixture();
    const { POST } =
      await import("@/app/api/v1/shares/[topic]/[slug]/[shareId]/exchange/route");
    let releaseAdmission: (() => void) | undefined;
    const admitted = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(value) {
          controller = value;
          releaseAdmission?.();
        },
      },
      { highWaterMark: 0 },
    );
    const input = new Request("https://example.org", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.token}`,
        "X-Sharing-Operation": "publish",
      },
      body,
      duplex: "half",
    } as RequestInit);
    const pending = POST(input, {
      params: Promise.resolve({
        topic: "nlp",
        slug: "attention",
        shareId: f.share.id,
      }),
    });
    await admitted;
    await f.storage.withCollaboration(f.share, async () =>
      f.storage.setParticipant(f.share, f.participant.id, "revoked"),
    );
    controller!.enqueue(
      new TextEncoder().encode(
        JSON.stringify({
          action: "publish",
          chat: {
            header: {
              id: "1".repeat(16),
              title: "Never published",
              username: "ana",
              createdAt: new Date().toISOString(),
            },
            messages: [],
          },
          assets: {},
          expected: null,
        }),
      ),
    );
    controller!.close();
    expect((await pending).status).toBe(403);
    const { readPublishedThreads } = await import("@/lib/sharing/threads");
    expect(readPublishedThreads(f.share)).toEqual([]);
  });
});

describe("trusted annotation reconstruction", () => {
  it("assigns approved authorship while preserving the paper and existing links", async () => {
    const f = await fixture();
    const original = fs.readFileSync(f.pdf);
    const { pdfEtag } = await import("@/lib/library/pdf/file");
    const proposed = await annotated(original);
    const remote = await PDFDocument.load(proposed);
    remote.getPage(0).drawText("Forged replacement content", { x: 50, y: 650 });
    remote.catalog.set(
      PDFName.of("OpenAction"),
      remote.context.obj({
        S: "JavaScript",
        JS: PDFString.of("malicious code"),
      }),
    );
    const response = await post(f.share.id, f.token, "save-pdf", {
      etag: pdfEtag(original),
      pdf: Buffer.from(await remote.save()).toString("base64"),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const result = fs.readFileSync(f.pdf);
    const details = await annotationDetails(result);
    expect(details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "/Link" }),
        expect.objectContaining({
          text: "A shared note",
          author: "Maya Approved",
          actor: `participant:${f.participant.id}`,
        }),
      ]),
    );
    const trusted = await PDFDocument.load(original);
    const saved = await PDFDocument.load(result);
    expect(saved.catalog.has(PDFName.of("OpenAction"))).toBe(false);
    const contentStreams = (document: PDFDocument) => {
      const contents = document.getPage(0).node.Contents();
      const objects =
        contents instanceof PDFArray
          ? contents.asArray()
          : contents
            ? [contents]
            : [];
      return objects.map((object) => {
        const stream = document.context.lookup(object);
        if (!(stream instanceof PDFRawStream))
          throw new Error("Expected a PDF content stream.");
        return Buffer.from(decodePDFRawStream(stream).decode()).toString(
          "latin1",
        );
      });
    };
    expect(contentStreams(saved)).toEqual(
      expect.arrayContaining(contentStreams(trusted)),
    );
    expect(contentStreams(saved).join("\n")).not.toContain(
      Buffer.from("Forged replacement content").toString("hex").toUpperCase(),
    );
    const note = details.find((value) => value.text === "A shared note")!;
    expect(note.name).toMatch(/^papernook-/);
    expect(note.name).not.toBe("client-id");
  });
  it("rejects replayed revisions and preserves the winning annotation", async () => {
    const f = await fixture();
    const original = fs.readFileSync(f.pdf);
    const { pdfEtag } = await import("@/lib/library/pdf/file");
    const body = {
      etag: pdfEtag(original),
      pdf: Buffer.from(await annotated(original)).toString("base64"),
    };
    expect((await post(f.share.id, f.token, "save-pdf", body)).status).toBe(
      200,
    );
    const saved = fs.readFileSync(f.pdf);
    expect((await post(f.share.id, f.token, "save-pdf", body)).status).toBe(
      412,
    );
    expect(fs.readFileSync(f.pdf)).toEqual(saved);
  });
  it("protects another reader's annotations from edits and deletion", async () => {
    const f = await fixture();
    const { pdfEtag } = await import("@/lib/library/pdf/file");
    const initial = fs.readFileSync(f.pdf);
    expect(
      (
        await post(f.share.id, f.token, "save-pdf", {
          etag: pdfEtag(initial),
          pdf: Buffer.from(await annotated(initial)).toString("base64"),
        })
      ).status,
    ).toBe(200);
    const otherToken = f.storage.newSecret();
    const other = f.storage.requestParticipant(
      f.share,
      otherToken,
      "Other reader",
    );
    f.storage.setParticipant(f.share, other.id, "approved");
    const saved = fs.readFileSync(f.pdf);
    const proposal = await PDFDocument.load(saved);
    const annotations = proposal.getPage(0).node.Annots()!;
    annotations.remove(annotations.size() - 1);
    expect(
      (
        await post(f.share.id, otherToken, "save-pdf", {
          etag: pdfEtag(saved),
          pdf: Buffer.from(await proposal.save()).toString("base64"),
        })
      ).status,
    ).toBe(403);
    expect(fs.readFileSync(f.pdf)).toEqual(saved);
  });
  it.each(["Link", "Widget", "FileAttachment"])(
    "rejects newly submitted %s annotations",
    async (type) => {
      const f = await fixture();
      const bytes = fs.readFileSync(f.pdf);
      const { reconstructAnnotations } = await import("@/lib/sharing/sandbox");
      await expect(
        reconstructAnnotations(bytes, await annotated(bytes, { type }), {
          id: "participant:test",
          name: "Maya",
        }),
      ).rejects.toMatchObject({ status: 422 });
      expect(fs.readFileSync(f.pdf)).toEqual(bytes);
    },
  );
  it("rejects out-of-page geometry and duplicate identities", async () => {
    const f = await fixture();
    const bytes = fs.readFileSync(f.pdf);
    const { reconstructAnnotations } = await import("@/lib/sharing/sandbox");
    await expect(
      reconstructAnnotations(bytes, await annotated(bytes, { x: 900 }), {
        id: "participant:test",
        name: "Maya",
      }),
    ).rejects.toMatchObject({ status: 422 });
    const duplicate = await annotated(await annotated(bytes), {
      name: "client-id",
      x: 150,
    });
    await expect(
      reconstructAnnotations(bytes, duplicate, {
        id: "participant:test",
        name: "Maya",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("rechecks profile revocation at the final PDF commit", async () => {
    const f = await fixture();
    const original = fs.readFileSync(f.pdf);
    const { pdfEtag } = await import("@/lib/library/pdf/file");
    const write = fsPromises.writeFile;
    let revoked = false;
    vi.spyOn(fsPromises, "writeFile").mockImplementation(async (...args) => {
      const result = await write(...args);
      if (
        !revoked &&
        String(args[0]).includes(".attention.pdf.") &&
        String(args[0]).endsWith(".tmp")
      ) {
        revoked = true;
        await revokeTestProfile("ana");
      }
      return result;
    });
    const response = await post(f.share.id, f.token, "save-pdf", {
      etag: pdfEtag(original),
      pdf: Buffer.from(await annotated(original)).toString("base64"),
    });
    expect(response.status).not.toBe(200);
    expect(revoked).toBe(true);
    expect(fs.readFileSync(f.pdf)).toEqual(original);
  });
  it("handles large valid base64 without recursive-regex stack overflow", async () => {
    const { base64Schema } = await import("@/lib/sharing/schema");
    const encoded = Buffer.alloc(8 * 1024 * 1024, 1).toString("base64");
    expect(base64Schema.parse(encoded)).toBe(encoded);
    expect(base64Schema.safeParse("AAAA=AAA").success).toBe(false);
  });
  it("rejects a highly compressed object stream before its oversized allocation", async () => {
    const f = await fixture();
    const original = fs.readFileSync(f.pdf);
    const bomb = await PDFDocument.load(original);
    bomb.context.register(
      bomb.context.flateStream(Buffer.alloc(20 * 1024 * 1024, 32), {
        Type: "ObjStm",
        N: 1,
        First: 0,
      }),
    );
    const proposed = await bomb.save({ useObjectStreams: false });
    const { reconstructAnnotations } = await import("@/lib/sharing/sandbox");
    await expect(
      reconstructAnnotations(original, proposed, {
        id: "participant:test",
        name: "Maya",
      }),
    ).rejects.toMatchObject({ status: 413 });
    expect(fs.readFileSync(f.pdf)).toEqual(original);
  });
});
