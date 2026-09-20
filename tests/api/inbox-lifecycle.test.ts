import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createTestProfile,
  deleteTestProfile,
  mockTestSession,
} from "../helpers/access";

let directory: string;
beforeEach(async () => {
  directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "papernook-inbox-lifecycle-"),
  );
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  await createTestProfile("Reader");
  await mockTestSession("reader");
});
afterEach(async () => {
  (await import("@/lib/library/index-db")).closeIndex();
  vi.doUnmock("next/headers");
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

it.each(["PATCH", "DELETE"] as const)(
  "rejects delayed %s without modifying a replacement profile's paper",
  async (method) => {
    const route = await import("@/app/api/v1/inbox/[slug]/route");
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let resume!: (value: { slug: string }) => void;
    const pending = new Promise<{ slug: string }>((resolve) => {
      resume = resolve;
    });
    const params = new Proxy(pending, {
      get(target, key) {
        if (key === "then") {
          entered();
          return target.then.bind(target);
        }
        return Reflect.get(target, key);
      },
    });
    const request = new NextRequest(
      "http://localhost/api/v1/inbox/replacement",
      {
        method,
        headers: { "Content-Type": "application/json" },
        ...(method === "PATCH"
          ? { body: JSON.stringify({ topic: "ml" }) }
          : {}),
      },
    );
    const response = route[method](request, { params });
    await started;
    await deleteTestProfile("reader");
    await createTestProfile("Reader");
    const papers = await import("@/lib/library/papers");
    papers.writeMeta(null, "replacement", {
      title: "Replacement profile's capture",
      authors: [],
      year: null,
      venue: null,
      arxivId: null,
      bibtex: null,
      tags: [],
      related: [],
      sourceUrl: "https://example.com/paper.pdf",
      addedAt: new Date().toISOString(),
      addedBy: "reader",
    });
    fs.writeFileSync(papers.pdfPath(null, "replacement"), "%PDF-1.4 private");
    resume({ slug: "replacement" });
    expect((await response).status).toBe(401);
    expect(papers.getPaper(null, "replacement")?.meta.title).toBe(
      "Replacement profile's capture",
    );
    expect(papers.getPaper("ml", "replacement")).toBeNull();
    expect(fs.readFileSync(papers.pdfPath(null, "replacement"), "utf8")).toBe(
      "%PDF-1.4 private",
    );
  },
);
