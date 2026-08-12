import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-test-"));
  process.env.PAPERNOOK_DATA_DIR = tmpDir;
  delete process.env.SESSION_SECRET;
  vi.resetModules();
});

afterEach(async () => {
  const { closeIndex } = await import("@/lib/library/index-db");
  closeIndex();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function users() {
  return import("@/lib/auth/users");
}

async function session() {
  return import("@/lib/auth/session");
}

async function rateLimit() {
  return import("@/lib/auth/rate-limit");
}

describe("profiles on disk", () => {
  it("creates a profile and lists it back from disk", async () => {
    const u = await users();
    const created = u.createProfile("Andres R", "jaguar");
    expect(created.username).toBe("andres-r");
    expect(created.avatarSlug).toBe("jaguar");
    const listed = u.listProfiles();
    expect(listed.map((p) => p.username)).toEqual(["andres-r"]);
  });

  it("rejects duplicate and unusable names", async () => {
    const u = await users();
    u.createProfile("Ana");
    expect(() => u.createProfile("Ana")).toThrow(/already exists/);
    expect(() => u.createProfile("!")).toThrow(/at least two/);
  });

  it("never resolves usernames outside the users root", async () => {
    const u = await users();
    expect(u.getProfile("../escape")).toBeNull();
    expect(u.getProfile("..")).toBeNull();
    expect(u.getProfile("a/../../b")).toBeNull();
  });

  it("keeps no per-profile credential and never leaks internals publicly", async () => {
    const u = await users();
    const created = u.createProfile("Ana", "jaguar");
    // Profiles separate whose chats are whose; the instance password is the
    // only credential, so a profile carries nothing to brute-force.
    const serialized = JSON.stringify(created);
    expect(serialized).not.toContain("passwordHash");
    const publicShape = JSON.stringify(u.toPublicProfile(created));
    expect(publicShape).not.toContain(created.captureToken);
    expect(publicShape).not.toContain("sessionEpoch");
  });
});

describe("capture token attribution", () => {
  it("resolves a token to exactly its owning profile", async () => {
    const u = await users();
    const ana = u.createProfile("Ana");
    const ben = u.createProfile("Ben");
    expect(u.profileForCaptureToken(ana.captureToken)?.username).toBe("ana");
    expect(u.profileForCaptureToken(ben.captureToken)?.username).toBe("ben");
  });

  it("rejects malformed and unknown tokens", async () => {
    const u = await users();
    u.createProfile("Ana");
    expect(u.profileForCaptureToken("a".repeat(48))).toBeNull();
    expect(u.profileForCaptureToken("not-a-token")).toBeNull();
    expect(u.profileForCaptureToken("")).toBeNull();
  });

  it("rotation invalidates the old token", async () => {
    const u = await users();
    const ana = u.createProfile("Ana");
    const old = ana.captureToken;
    const rotated = u.rotateCaptureToken("ana");
    expect(u.profileForCaptureToken(old)).toBeNull();
    expect(u.profileForCaptureToken(rotated.captureToken)?.username).toBe(
      "ana",
    );
  });
});

describe("sessions", () => {
  it("round-trips a valid token and rejects tampering", async () => {
    const u = await users();
    u.createProfile("Ana");
    const s = await session();
    const token = s.createSessionToken("ana");
    expect(s.verifySessionToken(token)).toBe("ana");
    // Forged username with the original signature must fail.
    const parts = token.split(".");
    expect(
      s.verifySessionToken(`ben.${parts[1]}.${parts[2]}.${parts[3]}`),
    ).toBeNull();
    // Truncated / garbage tokens must fail, not throw.
    expect(s.verifySessionToken("ana")).toBeNull();
    expect(s.verifySessionToken("")).toBeNull();
  });

  it("rejects expired tokens", async () => {
    const u = await users();
    u.createProfile("Ana");
    const s = await session();
    const past = Date.now() - 1000 * 60 * 60 * 24 * 120;
    const token = s.createSessionToken("ana", past);
    expect(s.verifySessionToken(token)).toBeNull();
  });

  it("revokes sessions when a profile is deleted or recreated", async () => {
    const u = await users();
    u.createProfile("Ana");
    const s = await session();
    const token = s.createSessionToken("ana");

    u.deleteProfile("ana");
    expect(s.verifySessionToken(token)).toBeNull();
    u.createProfile("Ana");
    expect(s.verifySessionToken(token)).toBeNull();
  });
});

describe("login rate limiting", () => {
  it("locks out after repeated failures with growing delays", async () => {
    const rl = await rateLimit();
    rl.resetRateLimits();
    const now = 1_000_000;
    for (let i = 0; i < 3; i += 1) rl.recordFailure("ip:1.2.3.4", now);
    expect(rl.retryAfterMs("ip:1.2.3.4", now)).toBe(0); // free attempts
    rl.recordFailure("ip:1.2.3.4", now);
    const first = rl.retryAfterMs("ip:1.2.3.4", now);
    expect(first).toBeGreaterThan(0);
    rl.recordFailure("ip:1.2.3.4", now);
    expect(rl.retryAfterMs("ip:1.2.3.4", now)).toBeGreaterThan(first);
  });

  it("success clears the bucket", async () => {
    const rl = await rateLimit();
    rl.resetRateLimits();
    for (let i = 0; i < 10; i += 1) rl.recordFailure("user:ana");
    expect(rl.retryAfterMs("user:ana")).toBeGreaterThan(0);
    rl.recordSuccess("user:ana");
    expect(rl.retryAfterMs("user:ana")).toBe(0);
  });

  it("buckets are independent per key", async () => {
    const rl = await rateLimit();
    rl.resetRateLimits();
    for (let i = 0; i < 10; i += 1) rl.recordFailure("user:ana");
    expect(rl.retryAfterMs("user:ben")).toBe(0);
  });
});

describe("wizard flag", () => {
  it("persists wizardDone across reads", async () => {
    const u = await users();
    u.createProfile("Ana");
    expect(u.getProfile("ana")?.wizardDone).toBeFalsy();
    u.markWizardDone("ana");
    expect(u.getProfile("ana")?.wizardDone).toBe(true);
  });
});

describe("admin-owned instance password", () => {
  it("verifies only the exact configured password", async () => {
    process.env.PAPERNOOK_PASSWORD = "correct-horse-battery";
    const u = await users();
    expect(u.instancePasswordConfigured()).toBe(true);
    expect(u.verifyInstancePassword("correct-horse-battery")).toBe(true);
    expect(u.verifyInstancePassword("wrong")).toBe(false);
    expect(u.verifyInstancePassword("")).toBe(false);
    expect(u.verifyInstancePassword("correct-horse-battery-x")).toBe(false);
    delete process.env.PAPERNOOK_PASSWORD;
  });

  it("reports unconfigured when the env var is absent", async () => {
    delete process.env.PAPERNOOK_PASSWORD;
    const u = await users();
    expect(u.instancePasswordConfigured()).toBe(false);
    expect(u.verifyInstancePassword("anything")).toBe(false);
  });
});

describe("admin role", () => {
  it("first profile is admin, later ones are members", async () => {
    const u = await users();
    const first = u.createProfile("Andres");
    const second = u.createProfile("Ana");
    expect(first.role).toBe("admin");
    expect(second.role).toBe("member");
    expect(u.toPublicProfile(first).isAdmin).toBe(true);
    expect(u.toPublicProfile(second).isAdmin).toBe(false);
  });

  it("promotes the oldest remaining profile when the admin is deleted", async () => {
    const u = await users();
    u.createProfile("Andres");
    u.createProfile("Ana");
    u.createProfile("Ben");
    u.deleteProfile("andres");
    expect(u.getProfile("andres")).toBeNull();
    expect(u.getProfile("ana")?.role).toBe("admin");
    expect(u.getProfile("ben")?.role).toBe("member");
  });

  it("erases private data while preserving anonymized shared papers", async () => {
    const u = await users();
    u.createProfile("Andres");
    u.createProfile("Ana");
    const papers = await import("@/lib/library/papers");
    const chats = await import("@/lib/library/chats");
    const index = await import("@/lib/library/index-db");

    const meta = {
      title: "A shared paper",
      authors: ["A. Researcher"],
      year: 2026,
      venue: null,
      arxivId: null,
      bibtex: null,
      tags: ["testing"],
      related: [],
      sourceUrl: "https://example.test/paper.pdf",
      addedAt: "2026-07-19T00:00:00.000Z",
      addedBy: "ana",
    };
    papers.writeMeta("research", "shared-paper", meta);
    fs.mkdirSync(path.dirname(papers.pdfPath("research", "shared-paper")), {
      recursive: true,
    });
    fs.writeFileSync(papers.pdfPath("research", "shared-paper"), "pdf");

    papers.writeMeta(null, "pending-paper", {
      ...meta,
      title: "Private pending capture",
    });
    fs.writeFileSync(papers.pdfPath(null, "pending-paper"), "pdf");

    const chat = chats.createChat(
      "research",
      "shared-paper",
      "ana",
      "Private notes",
    );
    const cropPath = path.join(
      papers.companionDir("research", "shared-paper"),
      "crops",
      "private.png",
    );
    fs.mkdirSync(path.dirname(cropPath), { recursive: true });
    fs.writeFileSync(cropPath, "image");
    chats.appendMessage("research", "shared-paper", "ana", chat.id, {
      role: "user",
      content: "Private question",
      images: ["crops/private.png"],
      at: "2026-07-19T00:00:00.000Z",
    });
    index.rebuildIndex();

    u.deleteProfile("ana");

    expect(u.getProfile("ana")).toBeNull();
    expect(chats.listChats("research", "shared-paper", "ana")).toEqual([]);
    expect(fs.existsSync(cropPath)).toBe(false);
    expect(papers.readMeta(null, "pending-paper")).toBeNull();
    expect(fs.existsSync(papers.pdfPath("research", "shared-paper"))).toBe(
      true,
    );
    expect(papers.readMeta("research", "shared-paper")?.addedBy).toBe(
      "deleted-profile",
    );
    expect(index.allIndexed()).toEqual([
      expect.objectContaining({
        slug: "shared-paper",
        addedBy: "deleted-profile",
      }),
    ]);
  });
});
