import { randomBytes, randomUUID } from "node:crypto";
import { withFileLock } from "thesidedoor-core/storage";
import {
  AccessError,
  AccessService,
  HouseholdProfileService,
  removePrincipalFromState,
} from "thesidedoor-core/access";
import { PapernookIdentityStore, type IdentityState } from "./identity-store";
import { normalizeUsername } from "./platform/profile-name";
import { animalForSeed, isAnimalSlug } from "./avatars";
import path from "node:path";
import { eraseProfileMetrics } from "../agent/platform/metrics";

export class ProfileOperations {
  private readonly access: AccessService;
  private readonly household: HouseholdProfileService;

  constructor(private readonly identity: PapernookIdentityStore) {
    this.access = new AccessService({ store: identity.accessStore() });
    this.household = new HouseholdProfileService(this.access);
  }

  async create(token: string, displayName: string, avatarSlug?: string) {
    const username = normalizeUsername(displayName);
    if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(username))
      throw new AccessError(
        "invalid",
        "Name must contain at least two letters or digits.",
      );
    if (avatarSlug && !isAnimalSlug(avatarSlug))
      throw new AccessError("invalid", "Choose a valid avatar.");
    return this.identity.transact((state) => {
      this.access.sessionFromState(state.access, token);
      if (state.access.mode !== "household")
        throw new AccessError(
          "forbidden",
          "Use an invitation to create an individual account.",
        );
      if (
        state.profiles.some((profile) => profile.username === username) ||
        state.erasures.some((erasure) => erasure.username === username)
      )
        throw new AccessError(
          "conflict",
          "This profile name is already in use or awaiting erasure.",
        );
      const principalId = randomUUID();
      const createdAt = new Date();
      const profile = {
        username,
        displayName: displayName.trim(),
        avatarSlug: avatarSlug ?? animalForSeed(username).slug,
        captureToken: randomBytes(24).toString("hex"),
        sessionEpoch: randomBytes(16).toString("hex"),
        createdAt: createdAt.toISOString(),
      };
      state.access.principals.push({
        id: principalId,
        name: username,
        role: "member",
        passwordHash: null,
        epoch: 0,
        createdAt: createdAt.getTime(),
      });
      state.profiles.push(profile);
      state.bindings[principalId] = username;
      state.generations[username] =
        (Object.hasOwn(state.generations, username)
          ? state.generations[username]!
          : 0) + 1;
      return profile;
    });
  }

  private selectedUsername(state: IdentityState, token: string): string | null {
    const auth = this.access.sessionFromState(state.access, token);
    return auth.principal
      ? (state.bindings[auth.principal.id] ?? null)
      : (this.household.selectedFromState(state.access, token)?.id ?? null);
  }

  async updateAvatar(token: string, username: string, avatarSlug: string) {
    if (!isAnimalSlug(avatarSlug))
      throw new AccessError("invalid", "Choose a valid avatar.");
    return this.identity.transact((state) => {
      if (this.selectedUsername(state, token) !== username)
        throw new AccessError("forbidden");
      const profile = state.profiles.find(
        (entry) => entry.username === username,
      );
      if (!profile) throw new AccessError("invalid");
      profile.avatarSlug = avatarSlug;
      return profile;
    });
  }

  async updatePreferences(
    token: string,
    username: string,
    changes: {
      wizardDone?: boolean;
      zotero?: IdentityState["profiles"][number]["zotero"] | null;
      rotateCaptureToken?: boolean;
    },
  ) {
    return this.identity.transact((state) => {
      if (this.selectedUsername(state, token) !== username)
        throw new AccessError("forbidden");
      const profile = state.profiles.find(
        (entry) => entry.username === username,
      );
      if (!profile) throw new AccessError("unauthorized");
      if (changes.wizardDone !== undefined)
        profile.wizardDone = changes.wizardDone;
      if (changes.zotero === null) delete profile.zotero;
      else if (changes.zotero !== undefined) profile.zotero = changes.zotero;
      if (changes.rotateCaptureToken)
        profile.captureToken = randomBytes(24).toString("hex");
      return profile;
    });
  }

  private deletionPermission(
    state: IdentityState,
    token: string,
    username: string,
  ) {
    const auth = this.access.sessionFromState(state.access, token);
    const principalId = Object.entries(state.bindings).find(
      ([, name]) => name === username,
    )?.[0];
    const principal = state.access.principals.find(
      (entry) => entry.id === principalId,
    );
    if (!principal)
      return { allowed: false, reason: "missing_profile" } as const;
    if (auth.principal) {
      if (auth.principal.id !== principal.id && auth.principal.role !== "owner")
        return { allowed: false, reason: "other_profile" } as const;
      if (
        principal.role === "owner" &&
        !state.access.principals.some(
          (entry) => entry.id !== principal.id && entry.role === "owner",
        )
      )
        return { allowed: false, reason: "last_owner" } as const;
      return {
        allowed: true,
        principalId: principal.id,
        requiresVerification: true,
      } as const;
    }
    const selected = this.household.selectedFromState(state.access, token)?.id;
    const admin = this.access.householdOwnerFromState(state.access, token);
    if (selected !== username && !admin)
      return { allowed: false, reason: "other_profile" } as const;
    if (principal.role !== "member" || principal.pendingRole)
      return { allowed: false, reason: "protected_account" } as const;
    return {
      allowed: true,
      principalId: principal.id,
      requiresVerification: false,
    } as const;
  }

  async deletionStatus(token: string, username: string) {
    return this.deletionPermission(await this.identity.read(), token, username);
  }

  /** Cleanup must be idempotent. Failed or interrupted cleanup retains its durable marker. */
  async finishErasure(
    username: string,
    generation: number,
    cleanup: () => Promise<void>,
    options: { signal?: AbortSignal } = {},
  ): Promise<boolean> {
    return withFileLock(
      this.identity.profileLockPath(username),
      async () => {
        const pending = (state: IdentityState) =>
          state.generations[username] === generation &&
          !state.profiles.some((profile) => profile.username === username) &&
          state.erasures.some(
            (entry) =>
              entry.username === username && entry.generation === generation,
          );
        const state = await this.identity.read();
        options.signal?.throwIfAborted();
        if (!pending(state)) return false;
        await cleanup();
        await eraseProfileMetrics(path.dirname(this.identity.file), {
          username,
          generation: generation - 1,
        });
        await this.identity.transact((state) => {
          if (!pending(state))
            throw new AccessError(
              "conflict",
              "Profile erasure changed during cleanup.",
            );
          state.erasures = state.erasures.filter(
            (entry) =>
              entry.username !== username || entry.generation !== generation,
          );
        });
        return true;
      },
      options,
    );
  }

  /** Revocation commits before any filesystem cleanup or wait for background writers. */
  async remove(token: string, username: string): Promise<void> {
    await this.identity.transact((state) => {
      const permission = this.deletionPermission(state, token, username);
      if (!permission.allowed)
        throw new AccessError("forbidden", permission.reason);
      if (permission.requiresVerification)
        this.access.sessionFromState(state.access, token, false, true);
      removePrincipalFromState(state.access, permission.principalId);
    });
  }
}
