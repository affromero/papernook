import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-share-"));
  process.env.PAPERNOOK_DATA_DIR = tmpDir;
  process.env.SESSION_SECRET = "s".repeat(64);
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function placePaper() {
  const { ensureDataDirs } = await import("@/lib/data-dir");
  const papers = await import("@/lib/library/papers");
  ensureDataDirs();
  papers.writeMeta("nlp", "attention", {
    title: "Attention Is All You Need",
    authors: ["Vaswani"],
    year: 2017,
    venue: "NeurIPS",
    arxivId: "1706.03762",
    bibtex: null,
    tags: ["transformers"],
    related: [],
    sourceUrl: "https://arxiv.org/abs/1706.03762",
    addedAt: new Date().toISOString(),
    addedBy: "ana",
  });
  papers.writeSummary("nlp", "attention", "The transformer paper.");
  const pdf = papers.pdfPath("nlp", "attention");
  fs.mkdirSync(path.dirname(pdf), { recursive: true });
  fs.writeFileSync(pdf, "%PDF-1.4 original");
  return papers.getPaper("nlp", "attention")!;
}

async function conversation(username: string, image?: string) {
  const chats = await import("@/lib/library/chats");
  const header = chats.createChat("nlp", "attention", username, "Deep read");
  chats.appendMessage("nlp", "attention", username, header.id, {
    role: "user",
    content: "Why does attention help?",
    images: image ? [`crops/${image}`] : undefined,
    at: new Date().toISOString(),
  });
  chats.appendMessage("nlp", "attention", username, header.id, {
    role: "assistant",
    content: "It shortens dependency paths.",
    at: new Date().toISOString(),
  });
  return header;
}

describe("view-only paper shares", () => {
  it("stores private atomic records and snapshots selected conversations", async () => {
    const paper = await placePaper();
    const header = await conversation("ana");
    const shares = await import("@/lib/library/shares");

    const share = shares.createShare("nlp", "attention", "ana", [header.id]);
    const storedFile = path.join(
      paper.companionDir,
      "shares",
      `${share.id}.json`,
    );
    expect(share.id).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.statSync(storedFile).mode & 0o777).toBe(0o600);
    expect(
      fs
        .readdirSync(path.dirname(storedFile))
        .every((name) => !name.endsWith(".tmp")),
    ).toBe(true);

    const chats = await import("@/lib/library/chats");
    chats.appendMessage("nlp", "attention", "ana", header.id, {
      role: "user",
      content: "This later turn stays private.",
      at: new Date().toISOString(),
    });

    const resolved = shares.getShare("nlp", "attention", share.id);
    expect(resolved?.conversations[0].messages).toHaveLength(2);
    expect(JSON.stringify(resolved)).not.toContain("later turn");
    expect(shares.listShares("nlp", "attention", "ana")).toHaveLength(1);
    expect(shares.listShares("nlp", "attention", "ben")).toHaveLength(0);
  });

  it("rejects another profile's chats and malformed identifiers", async () => {
    await placePaper();
    const header = await conversation("ben");
    const shares = await import("@/lib/library/shares");

    expect(() =>
      shares.createShare("nlp", "attention", "ana", [header.id]),
    ).toThrow(/Unknown conversation/);
    expect(() =>
      shares.createShare("nlp", "attention", "ana", ["../../private"]),
    ).toThrow(/Invalid conversations/);
    expect(
      shares.getShare("nlp", "attention", "../../session-secret"),
    ).toBeNull();
    expect(() => shares.createShare("_inbox", "attention", "ana", [])).toThrow(
      /Invalid slug/,
    );
  });

  it("serves only referenced crops from snapshotted conversations", async () => {
    const paper = await placePaper();
    const crops = path.join(paper.companionDir, "crops");
    fs.mkdirSync(crops, { recursive: true });
    fs.writeFileSync(path.join(crops, "referenced.png"), "image");
    fs.writeFileSync(path.join(crops, "private.png"), "secret");
    const header = await conversation("ana", "referenced.png");
    const shares = await import("@/lib/library/shares");
    const share = shares.createShare("nlp", "attention", "ana", [header.id]);

    expect(shares.resolveSharedCrop(share, "referenced.png")?.contentType).toBe(
      "image/png",
    );
    expect(shares.resolveSharedCrop(share, "private.png")).toBeNull();
    expect(shares.resolveSharedCrop(share, "../meta.json")).toBeNull();

    const route =
      await import("@/app/api/v1/shares/[topic]/[slug]/[shareId]/images/[imageName]/route");
    const referenced = await route.GET(
      new NextRequest("http://localhost/referenced.png"),
      {
        params: Promise.resolve({
          topic: "nlp",
          slug: "attention",
          shareId: share.id,
          imageName: "referenced.png",
        }),
      },
    );
    expect(referenced.status).toBe(200);
    expect(referenced.headers.get("content-type")).toBe("image/png");
    expect(referenced.headers.get("x-content-type-options")).toBe("nosniff");

    const privateCrop = await route.GET(
      new NextRequest("http://localhost/private.png"),
      {
        params: Promise.resolve({
          topic: "nlp",
          slug: "attention",
          shareId: share.id,
          imageName: "private.png",
        }),
      },
    );
    expect(privateCrop.status).toBe(404);
  });

  it("ignores malformed records and revocation immediately closes access", async () => {
    const paper = await placePaper();
    const shares = await import("@/lib/library/shares");
    const share = shares.createShare("nlp", "attention", "ana", []);
    fs.writeFileSync(
      path.join(paper.companionDir, "shares", `${"a".repeat(64)}.json`),
      '{"version":1}',
    );

    expect(shares.listShares("nlp", "attention", "ana")).toHaveLength(1);
    expect(shares.deleteShare("nlp", "attention", share.id, "ben")).toBe(false);
    expect(shares.getShare("nlp", "attention", share.id)).not.toBeNull();
    expect(shares.deleteShare("nlp", "attention", share.id, "ana")).toBe(true);
    expect(shares.getShare("nlp", "attention", share.id)).toBeNull();
  });

  it("revokes a member's links when that profile is deleted", async () => {
    await placePaper();
    const users = await import("@/lib/auth/users");
    users.createProfile("Admin");
    users.createProfile("Ana");
    const shares = await import("@/lib/library/shares");
    const share = shares.createShare("nlp", "attention", "ana", []);

    users.deleteProfile("ana");

    expect(shares.getShare("nlp", "attention", share.id)).toBeNull();
  });
});

describe("public share boundaries", () => {
  it("serves the current annotated PDF with private no-store headers", async () => {
    const paper = await placePaper();
    const shares = await import("@/lib/library/shares");
    const share = shares.createShare("nlp", "attention", "ana", []);
    fs.writeFileSync(paper.pdfPath, "%PDF-1.4 newly annotated");
    const route =
      await import("@/app/api/v1/shares/[topic]/[slug]/[shareId]/pdf/route");

    const response = await route.GET(
      new NextRequest("http://localhost/share.pdf"),
      {
        params: Promise.resolve({
          topic: "nlp",
          slug: "attention",
          shareId: share.id,
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("newly annotated");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");

    shares.deleteShare("nlp", "attention", share.id, "ana");
    const revoked = await route.GET(
      new NextRequest("http://localhost/share.pdf"),
      {
        params: Promise.resolve({
          topic: "nlp",
          slug: "attention",
          shareId: share.id,
        }),
      },
    );
    expect(revoked.status).toBe(404);
  });

  it("allows public share reads but keeps share mutations authenticated", async () => {
    const { proxy } = await import("@/proxy");
    const publicPage = proxy(
      new NextRequest(`http://localhost/share/nlp/attention/${"a".repeat(64)}`),
    );
    expect(publicPage.status).toBe(200);
    expect(publicPage.headers.get("referrer-policy")).toBe("no-referrer");
    expect(publicPage.headers.get("x-robots-tag")).toBe("noindex, nofollow");

    const publicAsset = proxy(
      new NextRequest(
        `http://localhost/api/v1/shares/nlp/attention/${"a".repeat(64)}/pdf`,
      ),
    );
    expect(publicAsset.status).toBe(200);

    const mutation = proxy(
      new NextRequest("http://localhost/api/v1/papers/nlp/attention/shares"),
    );
    expect(mutation.status).toBe(401);
  });

  it("renders a learning view without mutation affordances", async () => {
    await placePaper();
    const header = await conversation("ana");
    const shares = await import("@/lib/library/shares");
    const share = shares.createShare("nlp", "attention", "ana", [header.id]);
    const { default: SharePage } =
      await import("@/app/share/[topic]/[slug]/[shareId]/page");

    const html = renderToStaticMarkup(
      await SharePage({
        params: Promise.resolve({
          topic: "nlp",
          slug: "attention",
          shareId: share.id,
        }),
      }),
    );

    expect(html).toContain("View only");
    expect(html).toContain("Why does attention help?");
    expect(html).toContain('aria-label="Previous page"');
    expect(html).toContain('aria-label="Zoom in"');
    expect(html).not.toContain('aria-label="Save annotations in PDF"');
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("Save as exercise");
    expect(html).not.toContain("Create share");
    expect(html).not.toContain("Revoke");
  });
});
