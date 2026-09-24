import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { normalizeUsername } from "./platform/profile-name";
import { animalForSeed } from "./avatars";
import { z } from "zod";
import {
  AccessError,
  accessStateSchema,
  initialAccessState,
  type AccessState,
} from "thesidedoor-core/access";
import { FileStateStore, type StateStore } from "thesidedoor-core/storage";
import { aiStateSchema, initialAiState } from "../agent/state";

export const ERASURE_READY = "papernook-erasure-ownership-v1";

const profileSchema = z.object({
  username: z.string().regex(/^[a-z0-9][a-z0-9-]{1,30}$/),
  displayName: z.string().min(1),
  avatarSlug: z.string().min(1),
  role: z.enum(["admin", "member"]).optional(),
  captureToken: z.string().regex(/^[a-f0-9]{48}$/),
  sessionEpoch: z.string().optional(),
  wizardDone: z.boolean().optional(),
  createdAt: z.string().datetime(),
  zotero: z
    .object({
      apiKey: z.string(),
      userId: z.string(),
      target: z
        .object({
          type: z.enum(["user", "group"]),
          id: z.string(),
          name: z.string(),
        })
        .optional(),
      collectionKeys: z.array(z.string()).optional(),
    })
    .optional(),
});

const identitySchema = z
  .object({
    version: z.literal(1),
    migrationWarnings: z.array(z.string()).default([]),
    access: accessStateSchema,
    ai: aiStateSchema.default(initialAiState),
    profiles: z.array(profileSchema),
    bindings: z.record(z.string(), z.string()),
    generations: z.record(
      z.string(),
      z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    ),
    erasures: z.array(
      z.object({
        username: profileSchema.shape.username,
        generation: z.number().int().nonnegative(),
      }),
    ),
  })
  .superRefine((state, context) => {
    const names = new Set<string>();
    for (const profile of state.profiles) {
      if (names.has(profile.username))
        context.addIssue({
          code: "custom",
          message: "Duplicate profile identity",
        });
      names.add(profile.username);
      if (!Object.hasOwn(state.generations, profile.username))
        context.addIssue({
          code: "custom",
          message: "Profile generation is missing",
        });
    }
    const principals = new Set(
      state.access.principals.map((principal) => principal.id),
    );
    const bindings = Object.entries(state.bindings);
    if (
      bindings.length !== principals.size ||
      new Set(bindings.map(([, username]) => username)).size !==
        bindings.length ||
      bindings.some(([id]) => !principals.has(id))
    )
      context.addIssue({
        code: "custom",
        message: "Principal bindings must be complete and unique",
      });
    for (const username of Object.values(state.bindings))
      if (!names.has(username))
        context.addIssue({
          code: "custom",
          message: "Principal profile is missing",
        });
    if (state.profiles.length !== bindings.length)
      context.addIssue({
        code: "custom",
        message: "Every profile must have one principal binding",
      });
    if (state.erasures.some((erasure) => names.has(erasure.username)))
      context.addIssue({
        code: "custom",
        message: "A profile cannot be reused before erasure completes",
      });
  });

export type IdentityState = z.infer<typeof identitySchema>;
const ACCESS_READY = "papernook-filesystem-access-v1";

function initialIdentity(): IdentityState {
  return {
    version: 1,
    migrationWarnings: [],
    access: initialAccessState(),
    ai: initialAiState(),
    profiles: [],
    bindings: {},
    generations: {},
    erasures: [],
  };
}

function synchronizeProfiles(state: IdentityState): void {
  state.access.householdProfiles = state.profiles.map((profile) => {
    const owner = state.access.principals.find(
      (principal) =>
        principal.role === "owner" &&
        state.bindings[principal.id] === profile.username,
    );
    return {
      id: profile.username,
      name: profile.displayName,
      epoch: state.generations[profile.username]!,
      ...(owner ? { ownerPrincipalId: owner.id } : {}),
    };
  });
}

function reconcilePrincipals(state: IdentityState): void {
  const principals = new Set(
    state.access.principals.map((principal) => principal.id),
  );
  for (const [id, username] of Object.entries(state.bindings)) {
    if (principals.has(id)) continue;
    delete state.bindings[id];
    state.profiles = state.profiles.filter(
      (profile) => profile.username !== username,
    );
    const generation = (state.generations[username] ?? 0) + 1;
    state.generations[username] = generation;
    state.erasures.push({ username, generation });
  }
  for (const principal of state.access.principals) {
    if (Object.hasOwn(state.bindings, principal.id)) continue;
    const normalized = normalizeUsername(principal.name);
    const base = normalized.length >= 2 ? normalized : "member";
    let username = base;
    for (
      let suffix = 1;
      state.profiles.some((profile) => profile.username === username) ||
      state.erasures.some((erasure) => erasure.username === username);
      suffix++
    )
      username = `${base.slice(0, 22)}-${suffix}`;
    state.profiles.push({
      username,
      displayName: principal.name,
      avatarSlug: animalForSeed(username).slug,
      captureToken: randomBytes(24).toString("hex"),
      sessionEpoch: randomBytes(16).toString("hex"),
      createdAt: new Date(principal.createdAt).toISOString(),
    });
    state.bindings[principal.id] = username;
    state.generations[username] =
      (Object.hasOwn(state.generations, username)
        ? state.generations[username]!
        : 0) + 1;
  }
}

function validateTransition(before: IdentityState, after: IdentityState): void {
  for (const [id, username] of Object.entries(before.bindings))
    if (Object.hasOwn(after.bindings, id) && after.bindings[id] !== username)
      throw new AccessError(
        "conflict",
        "Existing principals cannot be rebound to another profile.",
      );
  for (const [username, generation] of Object.entries(before.generations))
    if (
      !Object.hasOwn(after.generations, username) ||
      after.generations[username]! < generation
    )
      throw new AccessError(
        "conflict",
        "Profile generations cannot be removed or decreased.",
      );
  for (const profile of before.profiles) {
    const current = after.profiles.find(
      (entry) => entry.username === profile.username,
    );
    if (current) {
      if (
        current.createdAt !== profile.createdAt ||
        current.sessionEpoch !== profile.sessionEpoch
      )
        throw new AccessError(
          "conflict",
          "Replace a profile through the account erasure workflow.",
        );
      continue;
    }
    const generation = after.generations[profile.username];
    if (
      generation === undefined ||
      generation <= before.generations[profile.username]! ||
      !after.erasures.some(
        (erasure) =>
          erasure.username === profile.username &&
          erasure.generation === generation,
      )
    )
      throw new AccessError(
        "conflict",
        "Profile deletion must invalidate access before erasing content.",
      );
  }
}

/** One authoritative file commits profile identity and access credentials together. */
export class PapernookIdentityStore {
  readonly file: string;
  private readonly storage: FileStateStore<IdentityState>;
  private initializing?: Promise<void>;

  constructor(private readonly directory: string) {
    this.file = path.join(directory, "identity.json");
    this.storage = new FileStateStore({
      path: this.file,
      initial: initialIdentity,
      parse: (value) => identitySchema.parse(value),
    });
  }

  private async initialize(): Promise<void> {
    if (
      !(await this.storage.read()).access.initializations.includes(ACCESS_READY)
    )
      throw new Error("Initialize canonical access before starting Papernook.");
  }

  /** Create canonical access and AI state before admitting traffic. */
  async initializeCanonical(): Promise<void> {
    this.initializing ??= this.prepareCanonicalState().finally(() => {
      this.initializing = undefined;
    });
    await this.initializing;
  }

  private async prepareCanonicalState(): Promise<void> {
    if (
      !(await this.storage.read()).access.initializations.includes(ACCESS_READY)
    )
      await this.createCanonicalState();
    const state = await this.storage.read();
    const owner = state.access.principals.find(
      (principal) => principal.role === "owner",
    );
    const username = owner && state.bindings[owner.id];
    if (
      state.access.mode === "household" &&
      username &&
      state.access.householdProfiles?.find((profile) => profile.id === username)
        ?.ownerPrincipalId !== owner.id
    )
      await this.storage.transact(synchronizeProfiles);
  }

  private async createCanonicalState(): Promise<void> {
    await this.storage.transact((state) => {
      if (state.access.initializations.includes(ACCESS_READY)) return;
      if (
        state.profiles.length ||
        Object.keys(state.bindings).length ||
        state.access.principals.length
      )
        throw new Error("Canonical access state is not empty");
      state.access = initialAccessState();
      state.access.initializations = [ACCESS_READY, ERASURE_READY];
      state.ai = initialAiState();
    });
  }

  async read(): Promise<IdentityState> {
    await this.initialize();
    return this.storage.read();
  }

  /** Atomic metadata snapshot for synchronous filesystem readers after startup migration. */
  readSnapshot(): IdentityState {
    const state = identitySchema.parse(
      JSON.parse(fs.readFileSync(this.file, "utf8")),
    );
    if (!state.access.initializations.includes(ACCESS_READY))
      throw new Error("Initialize canonical access before starting Papernook.");
    return state;
  }

  async transact<Result>(
    operation: (state: IdentityState) => Result,
  ): Promise<Result> {
    const snapshot = await this.read();
    return this.storage.transact((state) => {
      if (
        state.access.householdPasswordHash !==
        snapshot.access.householdPasswordHash
      )
        throw new AccessError(
          "conflict",
          "Access configuration changed. Retry the operation.",
        );
      const before = structuredClone(state);
      const result = operation(state);
      reconcilePrincipals(state);
      validateTransition(before, state);
      synchronizeProfiles(state);
      return result;
    });
  }

  accessStore(): StateStore<AccessState> {
    return {
      read: async () => (await this.read()).access,
      transact: (operation) =>
        this.transact((state) => operation(state.access)),
    };
  }

  profileLockPath(username: string): string {
    profileSchema.shape.username.parse(username);
    return path.join(this.directory, "locks", "profiles", `${username}.guard`);
  }
}
