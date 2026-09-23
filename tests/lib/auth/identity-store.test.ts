import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  AccessService,
  HouseholdProfileService,
  PrincipalManagement,
} from "thesidedoor-core/access";
import {
  CONFIGURED_PASSWORD_READY,
  PapernookIdentityStore,
  type IdentityState,
} from "@/lib/auth/identity-store";
import { ProfileOperations } from "@/lib/auth/profile-operations";
import {
  profileCapability,
  withProfileFiles,
  captureIdentity,
  acquireProfileActivity,
} from "@/lib/auth/profile-capability";
import { withFileLock, acquireFileLockSync } from "thesidedoor-core/storage";

let directory: string;
it("rejects stale private writes after a profile generation changes", async () => {
  const store = new PapernookIdentityStore(directory);
  await store.initializeCanonical();
  const capability = profileCapability(await store.read(), "owner");
  const destination = path.join(directory, "private-result.txt");
  withProfileFiles(store, capability, () =>
    fs.writeFileSync(destination, "original"),
  );
  await store.transact((state) => {
    state.generations.owner++;
  });
  expect(() =>
    withProfileFiles(store, capability, () =>
      fs.writeFileSync(destination, "stale"),
    ),
  ).toThrow("profile was replaced");
  expect(fs.readFileSync(destination, "utf8")).toBe("original");
});

it("holds cleanup until admitted profile activity releases and rejects new stale activity", async () => {
  const store = new PapernookIdentityStore(directory);
  await store.initializeCanonical();
  const capability = profileCapability(await store.read(), "owner");
  const release = await acquireProfileActivity(store, capability);
  try {
    await expect(
      withFileLock(store.profileLockPath("owner"), () => "cleanup", {
        timeoutMs: 30,
      }),
    ).rejects.toMatchObject({ code: "lock_busy" });
    await store.transact((state) => {
      state.generations.owner++;
    });
    await expect(
      acquireProfileActivity(store, capability),
    ).rejects.toMatchObject({ code: "unauthorized" });
  } finally {
    await release();
  }
  expect(
    await withFileLock(store.profileLockPath("owner"), () => "cleanup"),
  ).toBe("cleanup");
});

const password = "test household password";

async function adminSession(access: AccessService): Promise<string> {
  const token = await access.enterHousehold(password);
  await new HouseholdProfileService(access).select(token, "owner");
  return token;
}

it("authorizes profile preferences against the current selection and persisted session", async () => {
  const store = new PapernookIdentityStore(directory);
  await store.initializeCanonical();
  const access = new AccessService({ store: store.accessStore() });
  const token = await access.enterHousehold(password);
  const selection = new HouseholdProfileService(access);
  const operations = new ProfileOperations(store);
  const reader = await operations.create(token, "Reader");
  await selection.select(token, reader.username);
  await expect(
    operations.updatePreferences(token, "owner", { zotero: null }),
  ).rejects.toMatchObject({ code: "forbidden" });
  const updated = await operations.updatePreferences(token, reader.username, {
    wizardDone: true,
    rotateCaptureToken: true,
  });
  expect(updated.wizardDone).toBe(true);
  expect(updated.captureToken).not.toBe(reader.captureToken);
  await access.logout(token);
  await expect(
    operations.updatePreferences(token, reader.username, { wizardDone: false }),
  ).rejects.toMatchObject({ code: "unauthorized" });
  expect(
    (await store.read()).profiles.find(
      (entry) => entry.username === reader.username,
    )?.wizardDone,
  ).toBe(true);
});
it("admits capture tokens with their generation and rejects rotated credentials", async () => {
  const store = new PapernookIdentityStore(directory);
  await store.initializeCanonical();
  const admitted = await captureIdentity(store, profile.captureToken);
  expect(admitted?.capability).toEqual({ username: "owner", generation: 1 });
  expect(await captureIdentity(store, "malformed")).toBeNull();
  await store.transact((state) => {
    state.profiles[0]!.captureToken = "b".repeat(48);
  });
  expect(await captureIdentity(store, profile.captureToken)).toBeNull();
  expect((await captureIdentity(store, "b".repeat(48)))?.profile.username).toBe(
    "owner",
  );
});
it("retains failed erasure for retry and prevents old cleanup from touching a recreated profile", async () => {
  const store = new PapernookIdentityStore(directory);
  await store.initializeCanonical();
  const access = new AccessService({ store: store.accessStore() });
  const token = await access.enterHousehold(password);
  const operations = new ProfileOperations(store);
  const created = await operations.create(token, "Reader");
  const capability = profileCapability(await store.read(), created.username);
  await new HouseholdProfileService(access).select(token, created.username);
  await operations.remove(token, created.username);
  const marker = (await store.read()).erasures[0]!;
  const controller = new AbortController();
  const release = acquireFileLockSync(
    store.profileLockPath(marker.username),
    "shared",
  );
  const protectedFile = path.join(directory, "pending-private-data");
  fs.writeFileSync(protectedFile, "Private data awaiting erasure");
  try {
    const waiting = operations.finishErasure(
      marker.username,
      marker.generation,
      async () => {
        fs.rmSync(protectedFile);
      },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(fs.existsSync(protectedFile)).toBe(true);
    expect((await store.read()).erasures).toEqual([marker]);
  } finally {
    release();
  }
  await expect(
    operations.finishErasure(marker.username, marker.generation, async () => {
      throw new Error("disk unavailable");
    }),
  ).rejects.toThrow("disk unavailable");
  expect((await store.read()).erasures).toEqual([marker]);
  const results = await Promise.all([
    operations.finishErasure(
      marker.username,
      marker.generation,
      async () => {},
    ),
    operations.finishErasure(
      marker.username,
      marker.generation,
      async () => {},
    ),
  ]);
  expect(results.sort()).toEqual([false, true]);
  await operations.create(token, "Reader");
  const file = path.join(directory, "new-private-file");
  fs.writeFileSync(file, "new profile data");
  expect(
    await operations.finishErasure(
      marker.username,
      marker.generation,
      async () => {
        fs.unlinkSync(file);
      },
    ),
  ).toBe(false);
  expect(fs.readFileSync(file, "utf8")).toBe("new profile data");
  expect(() =>
    withProfileFiles(store, capability, () => fs.readFileSync(file, "utf8")),
  ).toThrow("profile was replaced");
  expect(() =>
    withProfileFiles(store, capability, () => fs.unlinkSync(file)),
  ).toThrow("profile was replaced");
});

let profile: IdentityState["profiles"][number];
const profilePreferences = {
  username: "owner",
  displayName: "Original owner",
  avatarSlug: "fox",
  role: "admin",
  captureToken: "a".repeat(48),
  wizardDone: true,
  zotero: {
    apiKey: "private-zotero-key",
    userId: "123",
    collectionKeys: ["papers"],
  },
};

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-identity-"));
  const identity = new PapernookIdentityStore(directory);
  await identity.initializeCanonical();
  const access = new AccessService({ store: identity.accessStore() });
  await access.claimOwner(
    await access.issueOperatorToken(),
    "owner",
    password,
    "household",
  );
  await identity.transact((state) => {
    Object.assign(state.profiles[0]!, profilePreferences);
  });
  profile = structuredClone((await identity.read()).profiles[0]!);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

it("seeds the configured instance password once and preserves later owner changes", async () => {
  const configured = "configured instance password";
  vi.stubEnv("PAPERNOOK_PASSWORD", configured);
  const store = new PapernookIdentityStore(directory);
  await store.transact((state) => {
    state.access.initializations = state.access.initializations.filter(
      (item) => item !== CONFIGURED_PASSWORD_READY,
    );
  });
  await store.initializeCanonical();
  const access = new AccessService({ store: store.accessStore() });
  const configuredSession = await access.enterHousehold(configured);
  expect((await access.authenticate(configuredSession)).principal).toBeNull();
  expect((await store.read()).access.initializations).toContain(
    CONFIGURED_PASSWORD_READY,
  );

  const owner = await access.enterHousehold(configured);
  await new HouseholdProfileService(access).select(owner, "owner");
  await access.configureHousehold(owner, "owner replacement password");
  vi.stubEnv("PAPERNOOK_PASSWORD", "changed environment password");
  await new PapernookIdentityStore(directory).initializeCanonical();
  await expect(
    access.enterHousehold("changed environment password"),
  ).rejects.toMatchObject({ code: "unauthorized" });
  expect(
    (
      await access.authenticate(
        await access.enterHousehold("owner replacement password"),
      )
    ).principal,
  ).toBeNull();
});

it("permits household profile creation and erasure without granting owner-account deletion", async () => {
  const store = new PapernookIdentityStore(directory);
  await store.initializeCanonical();
  const access = new AccessService({ store: store.accessStore() });
  const profiles = new HouseholdProfileService(access);
  const operations = new ProfileOperations(store);
  const guest = await access.enterHousehold(password);
  await profiles.select(guest, "owner");
  await expect(operations.remove(guest, "owner")).rejects.toMatchObject({
    code: "forbidden",
  });
  const created = await operations.create(guest, "New Reader");
  await profiles.select(guest, created.username);
  await operations.remove(guest, created.username);
  expect(await profiles.selected(guest)).toBeNull();
  await expect(operations.create(guest, "New Reader")).rejects.toMatchObject({
    code: "conflict",
  });
});

it("allows household erasure while rejecting an individual profile password", async () => {
  const store = new PapernookIdentityStore(directory);
  await store.initializeCanonical();
  const access = new AccessService({ store: store.accessStore() });
  const owner = await adminSession(access);
  const operations = new ProfileOperations(store);
  const guest = await access.enterHousehold(password);
  const profile = await operations.create(guest, "Reader");
  await new HouseholdProfileService(access).select(guest, profile.username);
  const id = Object.entries((await store.read()).bindings).find(
    ([, username]) => username === profile.username,
  )![0];
  const results = await Promise.allSettled([
    operations.remove(guest, profile.username),
    new PrincipalManagement(access).mutate(owner, {
      kind: "update",
      id,
      password: "individual reader password",
    }),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  const current = (await store.read()).access.principals.find(
    (principal) => principal.id === id,
  );
  expect(results[0]?.status).toBe("fulfilled");
  expect(results[1]?.status).toBe("rejected");
  expect(current).toBeUndefined();
});

it("keeps the first Admin and rejects a second Admin account", async () => {
  const store = new PapernookIdentityStore(directory);
  await store.initializeCanonical();
  const access = new AccessService({ store: store.accessStore() });
  const first = await adminSession(access);
  await expect(
    new PrincipalManagement(access).mutate(first, {
      kind: "create",
      name: "Second Owner",
      role: "owner",
      password: "second owner password",
    }),
  ).rejects.toMatchObject({ code: "forbidden" });
  const operations = new ProfileOperations(store);
  await expect(operations.remove(first, "owner")).rejects.toMatchObject({
    code: "forbidden",
  });
  expect(
    (await store.read()).access.principals.filter(
      (principal) => principal.role === "owner",
    ),
  ).toHaveLength(1);
});

it("rejects rebinding or replacing a live identity without erasure", async () => {
  const store = new PapernookIdentityStore(directory);
  await store.initializeCanonical();
  const ownerId = Object.entries((await store.read()).bindings).find(
    ([, username]) => username === "owner",
  )![0];
  await expect(
    store.transact((state) => {
      state.bindings[ownerId] = "someone-else";
    }),
  ).rejects.toThrow("cannot be rebound");
  await expect(
    store.transact((state) => {
      state.profiles[0]!.sessionEpoch = "replacement";
    }),
  ).rejects.toThrow("erasure workflow");
  await expect(
    store.transact((state) => {
      state.generations.owner = 0;
    }),
  ).rejects.toThrow("cannot be removed or decreased");
  expect((await store.read()).profiles).toEqual([profile]);
});

it("keeps the owner's existing profile and tombstones removed member identities", async () => {
  const store = new PapernookIdentityStore(directory);
  await store.initializeCanonical();
  const access = new AccessService({ store: store.accessStore() });
  const owner = await adminSession(access);
  expect((await access.authenticate(owner, true)).principal?.role).toBe(
    "owner",
  );
  expect((await store.read()).profiles).toEqual([profile]);
  const management = new PrincipalManagement(access);
  const id = await management.mutate(owner, {
    kind: "create",
    name: "../New reader",
  });
  const before = await store.read();
  const username = before.bindings[id]!;
  expect(username).toBe("new-reader");
  expect(
    before.profiles.find((entry) => entry.username === username)?.captureToken,
  ).toMatch(/^[a-f0-9]{48}$/);
  const household = await access.enterHousehold(password);
  const selection = new HouseholdProfileService(access);
  await selection.select(household, username);
  await management.mutate(owner, { kind: "delete", id });
  const after = await store.read();
  expect(after.profiles.some((entry) => entry.username === username)).toBe(
    false,
  );
  expect(after.erasures).toContainEqual({ username, generation: 2 });
  expect(await selection.selected(household)).toBeNull();
});

it("keeps claimed access authority across restarts", async () => {
  const first = new PapernookIdentityStore(directory);
  await first.initializeCanonical();
  await first.read();
  const restarted = new PapernookIdentityStore(directory);
  const restartedAccess = new AccessService({ store: restarted.accessStore() });
  await expect(
    restartedAccess.enterHousehold("different household password"),
  ).rejects.toMatchObject({ code: "unauthorized" });
  const token = await restartedAccess.enterHousehold(password);
  expect((await restartedAccess.authenticate(token)).principal).toBeNull();
  expect((await first.read()).profiles).toEqual([profile]);
});

it("commits profile generations and selection invalidation in the same file", async () => {
  const store = new PapernookIdentityStore(directory);
  await store.initializeCanonical();
  const access = new AccessService({ store: store.accessStore() });
  const token = await access.enterHousehold(password);
  const selection = new HouseholdProfileService(access);
  await selection.select(token, "owner");
  await expect(
    store.transact((state) => {
      state.generations.owner++;
      state.profiles[0]!.displayName = "Uncommitted";
      throw new Error("injected transaction failure");
    }),
  ).rejects.toThrow("injected transaction failure");
  expect(await selection.selected(token)).toEqual({
    id: "owner",
    name: "Original owner",
  });
  await store.transact((state) => {
    state.generations.owner++;
  });
  expect(await selection.selected(token)).toBeNull();
});
