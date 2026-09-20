import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AccessService,
  HouseholdProfileService,
} from "thesidedoor-core/access";
import {
  createTestProfile,
  deleteTestProfile,
  testAccess,
  testSession,
  TEST_ACCESS_PASSWORD,
} from "../helpers/access";
import { captureIdentity } from "@/lib/auth/profile-capability";

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-account-test-"));
  vi.stubEnv("PAPERNOOK_DATA_DIR", tmpDir);
  vi.resetModules();
});
afterEach(async () => {
  const { closeIndex } = await import("@/lib/library/index-db");
  closeIndex();
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
async function users() {
  return import("@/lib/auth/users");
}
async function rateLimit() {
  return import("@/lib/auth/rate-limit");
}

describe("authoritative profiles", () => {
  it("persists profile changes in the authoritative identity envelope", async () => {
    const u = await users();
    const created = await createTestProfile("Andres R", "jaguar");
    expect(u.listProfiles().map((profile) => profile.username)).toEqual([
      "fixture-owner",
      "andres-r",
    ]);
    const token = await testSession(created.username);
    const updated = await u.updateProfileAvatar(
      created.username,
      "toucan",
      token,
    );
    expect(u.getProfile(created.username)).toEqual(updated);
    expect(updated.avatarSlug).toBe("toucan");
    await u.markWizardDone(created.username, token);
    expect(u.getProfile(created.username)?.wizardDone).toBe(true);
    expect(
      fs.existsSync(
        path.join(tmpDir, "users", created.username, "profile.json"),
      ),
    ).toBe(false);
  });

  it("rejects duplicate names, unusable names, invalid avatars, and another selected profile", async () => {
    const u = await users();
    await createTestProfile("Ana");
    await createTestProfile("Ben");
    const token = await testSession("ana");
    await expect(
      u.createProfile("Ana", undefined, token),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(u.createProfile("!", undefined, token)).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(
      u.updateProfileAvatar("ana", "unknown", token),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      u.updateProfileAvatar("ben", "toucan", token),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(u.getProfile("../escape")).toBeNull();
    expect(u.getProfile("a/../../b")).toBeNull();
  });

  it("keeps credentials and authority out of a selected profile's public representation", async () => {
    const u = await users();
    const profile = await createTestProfile("Owner", undefined, true);
    const publicProfile = u.toPublicProfile(profile);
    expect(publicProfile.isAdmin).toBe(false);
    expect(publicProfile).not.toHaveProperty("captureToken");
    expect(publicProfile).not.toHaveProperty("sessionEpoch");
    expect(publicProfile).not.toHaveProperty("passwordHash");
    const { access } = await testAccess();
    const token = await testSession("owner");
    expect((await access.authenticate(token)).principal).toBeNull();
    expect(u.toPublicProfile(profile, true).isAdmin).toBe(true);
  });

  it("rotates capture admission without changing the profile identity", async () => {
    const u = await users();
    const profile = await createTestProfile("Ana");
    const { identity } = await testAccess();
    const before = await captureIdentity(identity, profile.captureToken);
    const updated = await u.rotateCaptureToken("ana", await testSession("ana"));
    expect(await captureIdentity(identity, profile.captureToken)).toBeNull();
    expect(
      (await captureIdentity(identity, updated.captureToken))?.capability,
    ).toEqual(before?.capability);
    expect(await captureIdentity(identity, "invalid")).toBeNull();
  });

  it("invalidates selection after deletion and recreation without invalidating unrelated profiles", async () => {
    await createTestProfile("Ana");
    await createTestProfile("Ben");
    const { verifySessionToken } = await import("@/lib/auth/session");
    const old = await testSession("ana");
    const other = await testSession("ben");
    await deleteTestProfile("ana");
    await createTestProfile("Ana");
    expect(await verifySessionToken(old)).toBeNull();
    expect(await verifySessionToken(other)).toBe("ben");
    expect(await verifySessionToken("invalid")).toBeNull();
  });

  it("rejects a persisted expired session", async () => {
    await createTestProfile("Ana");
    const { identity } = await testAccess();
    const past = Date.now() - 10000;
    const access = new AccessService({
      store: identity.accessStore(),
      now: () => past,
      householdSessionTtlMs: 1,
    });
    const token = await access.enterHousehold(TEST_ACCESS_PASSWORD);
    await new HouseholdProfileService(access).select(token, "ana");
    const { verifySessionToken } = await import("@/lib/auth/session");
    expect(await verifySessionToken(token)).toBeNull();
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

describe("profile erasure", () => {
  it("erases private data while preserving anonymized shared papers", async () => {
    const u = await users();
    await createTestProfile("Andres");
    await createTestProfile("Ana");
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

    await deleteTestProfile("ana");

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
