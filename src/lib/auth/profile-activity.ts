import { isAccessError } from "thesidedoor-core/access";
import { acquireFileLockSync } from "thesidedoor-core/storage";
import { dataRoot } from "../data-dir";
import { PapernookIdentityStore } from "./identity-store";
import {
  profileCapability,
  type ProfileCapability,
} from "./profile-capability";

export interface ProfileActivity {
  readonly username: string;
  readonly capability: ProfileCapability;
  cancelled(): boolean;
  finish(): void;
}

/** Preserve admission identity while holding cleanup off across processes. */
export function beginProfileActivity(
  capability: ProfileCapability,
): ProfileActivity | null {
  const identity = new PapernookIdentityStore(dataRoot());
  const admitted = Object.freeze({ ...capability });
  const release = acquireFileLockSync(
    identity.profileLockPath(admitted.username),
    "shared",
  );
  let finished = false;
  function cancelled(): boolean {
    if (finished) return true;
    try {
      return (
        profileCapability(identity.readSnapshot(), admitted.username)
          .generation !== admitted.generation
      );
    } catch (error) {
      if (isAccessError(error) && error.code === "unauthorized") return true;
      throw error;
    }
  }
  try {
    if (cancelled()) {
      release();
      return null;
    }
    return {
      username: admitted.username,
      capability: admitted,
      cancelled,
      finish() {
        if (finished) return;
        finished = true;
        release();
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}
