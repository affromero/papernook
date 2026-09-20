import fs from "node:fs";
import path from "node:path";
import { syncDirectory } from "thesidedoor-core/storage";
import { usersRoot, dataRoot } from "../data-dir";
import { deleteChatsByUser } from "../library/chats";
import { rebuildIndex } from "../library/index-db";
import { anonymizePapersByUser } from "../library/papers";
import { deleteSharesByOwner } from "../library/shares";
import { PapernookIdentityStore } from "./identity-store";
import { ProfileOperations } from "./profile-operations";
import { assertSlug } from "../library/slug";
export { normalizeUsername } from "./platform/profile-name";

export interface ZoteroLibraryTarget {
  type: "user" | "group";
  id: string;
  name: string;
}

export interface ZoteroProfileConfig {
  apiKey: string;
  /** Owner of the API key; also used to discover accessible groups. */
  userId: string;
  /** Missing on legacy profiles, which means the owner's personal library. */
  target?: ZoteroLibraryTarget;
  /** Empty or missing means the whole selected library. */
  collectionKeys?: string[];
}

export interface Profile {
  username: string;
  displayName: string;
  avatarSlug: string;
  /** First profile created on the instance is the admin. */
  role?: "admin" | "member";
  /** Attributes /add captures (and their starter chats) to this profile. */
  captureToken: string;
  /** Revokes every signed session when the profile is deleted and recreated. */
  sessionEpoch?: string;
  /** True once the per-profile onboarding wizard has been completed. */
  wizardDone?: boolean;
  /** Connected Zotero library for pull-only sync. */
  zotero?: ZoteroProfileConfig;
  createdAt: string;
}

/** Shape safe to send to the browser (no token, no hash). */
export interface PublicProfile {
  username: string;
  displayName: string;
  avatarSlug: string;
  isAdmin: boolean;
}

function identity() {
  return new PapernookIdentityStore(dataRoot());
}

/** Metadata reads use the atomic envelope. Request admission validates access separately. */
export function listProfiles(): Profile[] {
  return identity()
    .readSnapshot()
    .profiles.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getProfile(username: string): Profile | null {
  if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(username)) return null;
  return (
    identity()
      .readSnapshot()
      .profiles.find((profile) => profile.username === username) ?? null
  );
}

export function toPublicProfile(
  profile: Profile,
  ownerAuthority = false,
): PublicProfile {
  return {
    username: profile.username,
    displayName: profile.displayName,
    avatarSlug: profile.avatarSlug,
    isAdmin: ownerAuthority,
  };
}

export function createProfile(
  displayName: string,
  avatarSlug: string | undefined,
  token: string,
): Promise<Profile> {
  return new ProfileOperations(identity()).create(
    token,
    displayName,
    avatarSlug,
  );
}

export function updateProfileAvatar(
  username: string,
  avatarSlug: string,
  token: string,
): Promise<Profile> {
  return new ProfileOperations(identity()).updateAvatar(
    token,
    username,
    avatarSlug,
  );
}

/** Called only under an exclusive profile lease after committed principal revocation. */
export function eraseProfileFiles(username: string): void {
  assertSlug(username);
  deleteChatsByUser(username);
  deleteSharesByOwner(username);
  anonymizePapersByUser(username);
  fs.rmSync(path.join(usersRoot(), username), { recursive: true, force: true });
  syncDirectory(usersRoot());
  rebuildIndex();
}

export async function markWizardDone(
  username: string,
  token: string,
): Promise<void> {
  await new ProfileOperations(identity()).updatePreferences(token, username, {
    wizardDone: true,
  });
}

export function setZoteroConfig(
  username: string,
  zotero: ZoteroProfileConfig | null,
  token: string,
): Promise<Profile> {
  return new ProfileOperations(identity()).updatePreferences(token, username, {
    zotero,
  });
}

export function rotateCaptureToken(
  username: string,
  token: string,
): Promise<Profile> {
  return new ProfileOperations(identity()).updatePreferences(token, username, {
    rotateCaptureToken: true,
  });
}
