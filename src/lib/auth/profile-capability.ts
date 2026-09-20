import { AccessError } from "thesidedoor-core/access";
import { timingSafeEqual } from "node:crypto";
import {
  acquireFileLock,
  withSharedFileLockSync,
} from "thesidedoor-core/storage";
import type { PapernookIdentityStore, IdentityState } from "./identity-store";

export interface ProfileCapability {
  readonly username: string;
  readonly generation: number;
}

/** Capture admission uses the token and generation from one authoritative snapshot. */
export async function captureIdentity(
  identity: PapernookIdentityStore,
  token: string,
) {
  if (!/^[a-f0-9]{48}$/.test(token)) return null;
  const state = await identity.read();
  const supplied = Buffer.from(token, "hex");
  const profile = state.profiles.find((entry) =>
    timingSafeEqual(Buffer.from(entry.captureToken, "hex"), supplied),
  );
  if (!profile) return null;
  return { profile, capability: profileCapability(state, profile.username) };
}

/** Resolve at authenticated admission and preserve this generation through queued work. */
export function profileCapability(
  state: IdentityState,
  username: string,
): ProfileCapability {
  if (
    !state.profiles.some((profile) => profile.username === username) ||
    !Object.hasOwn(state.generations, username) ||
    state.erasures.some((erasure) => erasure.username === username)
  )
    throw new AccessError(
      "unauthorized",
      "This profile is no longer available.",
    );
  return Object.freeze({ username, generation: state.generations[username]! });
}

function validate(
  identity: PapernookIdentityStore,
  capability: ProfileCapability,
): void {
  const current = profileCapability(
    identity.readSnapshot(),
    capability.username,
  );
  if (current.generation !== capability.generation)
    throw new AccessError(
      "unauthorized",
      "This profile was replaced. Start the operation again.",
    );
}

/** Protect private reads and writes from access to a later profile with the same name. */
export function withProfileFiles<Result>(
  identity: PapernookIdentityStore,
  capability: ProfileCapability,
  operation: () => Result &
    (Result extends PromiseLike<unknown> ? never : unknown),
): Result {
  return withSharedFileLockSync(
    identity.profileLockPath(capability.username),
    () => {
      validate(identity, capability);
      return operation();
    },
  );
}

/** A shared lease lets independent jobs proceed while deletion waits for their completion. */
export async function withProfileActivity<Result>(
  identity: PapernookIdentityStore,
  capability: ProfileCapability,
  operation: () => Promise<Result>,
  signal?: AbortSignal,
): Promise<Result> {
  const release = await acquireProfileActivity(identity, capability, signal);
  try {
    return await operation();
  } finally {
    await release();
  }
}

/** Acquire before resource locks and release after their final private file access. */
export async function acquireProfileActivity(
  identity: PapernookIdentityStore,
  capability: ProfileCapability,
  signal?: AbortSignal,
): Promise<() => Promise<void>> {
  const release = await acquireFileLock(
    identity.profileLockPath(capability.username),
    { mode: "shared", signal },
  );
  try {
    validate(identity, capability);
  } catch (error) {
    await release();
    throw error;
  }
  return release;
}
