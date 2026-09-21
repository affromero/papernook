import { vi } from "vitest";
import {
  AccessService,
  HouseholdProfileService,
  PrincipalManagement,
} from "thesidedoor-core/access";
import { PapernookIdentityStore } from "@/lib/auth/identity-store";
import { ProfileOperations } from "@/lib/auth/profile-operations";
import { normalizeUsername } from "@/lib/auth/platform/profile-name";
import type { ZoteroProfileConfig } from "@/lib/auth/users";
import { profileCapability } from "@/lib/auth/profile-capability";

export function testProfileCapability(username: string) {
  const directory = process.env.PAPERNOOK_DATA_DIR;
  if (!directory)
    throw new Error("Profile fixtures require an isolated data directory");
  return profileCapability(
    new PapernookIdentityStore(directory).readSnapshot(),
    username,
  );
}

export const TEST_ACCESS_PASSWORD = "test household password phrase";
const accountPassword = "test individual account password";

export async function testAccess() {
  const directory = process.env.PAPERNOOK_DATA_DIR;
  if (!directory)
    throw new Error("Access fixtures require an isolated PAPERNOOK_DATA_DIR");
  vi.stubEnv("PAPERNOOK_URL", "http://localhost");
  const identity = new PapernookIdentityStore(directory);
  await identity.initializeCanonical();
  const access = new AccessService({ store: identity.accessStore() });
  if ((await identity.read()).access.principals.length === 0) {
    const owner = await access.claimOwner(
      await access.issueOperatorToken(),
      "Fixture Owner",
      accountPassword,
      "household",
    );
    await access.configureHousehold(owner, TEST_ACCESS_PASSWORD);
  }
  return { identity, access, profiles: new HouseholdProfileService(access) };
}

export async function createTestProfile(
  name: string,
  avatar?: string,
  owner = false,
) {
  const { identity, access } = await testAccess();
  const username = normalizeUsername(name);
  const state = await identity.read();
  const existing = state.profiles.find(
    (profile) => profile.username === username,
  );
  if (existing) return existing;
  if (owner) {
    const administrator = state.access.principals.find(
      (principal) => principal.role === "owner",
    );
    if (administrator) {
      const token = await access.login(administrator.name, accountPassword);
      await new PrincipalManagement(access).mutate(token, {
        kind: "create",
        name,
        role: "owner",
        password: accountPassword,
      });
    } else {
      await access.claimOwner(
        await access.issueOperatorToken(),
        name,
        accountPassword,
        "household",
      );
    }
    const profile = (await identity.read()).profiles.find(
      (entry) => entry.username === username,
    );
    if (!profile) throw new Error("Owner creation did not create a profile");
    return profile;
  }
  const token = await access.enterHousehold(TEST_ACCESS_PASSWORD);
  return new ProfileOperations(identity).create(token, name, avatar);
}

export async function testSession(
  username: string,
  individual = false,
): Promise<string> {
  const { identity, access, profiles } = await testAccess();
  if (individual) {
    const state = await identity.read();
    const id = Object.entries(state.bindings).find(
      ([, name]) => name === username,
    )?.[0];
    const principal = state.access.principals.find((entry) => entry.id === id);
    if (!principal) throw new Error("Fixture account does not exist");
    return access.login(principal.name, accountPassword);
  }
  const token = await access.enterHousehold(TEST_ACCESS_PASSWORD);
  await profiles.select(token, username);
  return token;
}

export async function deleteTestProfile(username: string): Promise<void> {
  await (
    await revokeTestProfile(username)
  )();
}

export async function revokeTestProfile(
  username: string,
): Promise<() => Promise<void>> {
  const { identity } = await testAccess();
  const token = await testSession(username);
  const operations = new ProfileOperations(identity);
  await operations.remove(token, username);
  const marker = (await identity.read()).erasures.find(
    (entry) => entry.username === username,
  );
  if (!marker) throw new Error("Profile deletion did not queue erasure");
  const { eraseProfileFiles } = await import("@/lib/auth/users");
  return async () => {
    await operations.finishErasure(username, marker.generation, async () => {
      eraseProfileFiles(username);
    });
  };
}

export async function setTestZoteroConfig(
  username: string,
  config: ZoteroProfileConfig | null,
) {
  const token = await testSession(username);
  const { setZoteroConfig } = await import("@/lib/auth/users");
  return setZoteroConfig(username, config, token);
}

const frameworkSession = { token: null as string | null };
const frameworkHeaders = {
  cookies: async () => ({
    get: (name: string) =>
      name === "papernook_access" && frameworkSession.token
        ? { value: frameworkSession.token }
        : undefined,
  }),
};

/** Mock the framework cookie boundary, never application authorization. */
export async function mockTestSession(
  username: string | null,
  individual = false,
) {
  const token = username ? await testSession(username, individual) : null;
  frameworkSession.token = token;
  vi.doMock("next/headers", () => frameworkHeaders);
  return token;
}
