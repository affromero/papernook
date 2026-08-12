import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { usersRoot, ensureDataDirs } from "../data-dir";
import { deleteChatsByUser } from "../library/chats";
import { rebuildIndex } from "../library/index-db";
import { anonymizePapersByUser } from "../library/papers";
import { deleteSharesByOwner } from "../library/shares";
import { isAnimalSlug, animalForSeed } from "./avatars";

/**
 * Profiles on disk: data/users/<username>/profile.json. The shared library is
 * common to everyone; chats and capture tokens are per-profile.
 *
 * One credential guards the instance: PAPERNOOK_PASSWORD, checked at the
 * access gate. Past the gate, picking a profile is a choice, not an
 * authentication step — profiles separate whose chats are whose, the way a
 * streaming service separates viewers, and are deliberately not a security
 * boundary between people who share the instance password.
 */

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

const USERNAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

export function normalizeUsername(displayName: string): string {
  return displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 31);
}

function profilePath(username: string): string {
  return path.join(usersRoot(), username, "profile.json");
}

function readProfile(username: string): Profile | null {
  // Reject anything that could traverse out of the users root.
  if (!USERNAME_RE.test(username)) return null;
  try {
    const raw = fs.readFileSync(profilePath(username), "utf8");
    const parsed = JSON.parse(raw) as Profile & { passwordHash?: string };
    // The name inside the file must match the directory it was read from.
    // Otherwise a session for "ana" would carry username "ben", and every
    // later write — capture token, Zotero config, wizard state, deletion —
    // would land in Ben's storage.
    if (parsed.username !== username) return null;
    // A profile written before per-profile passwords were removed still
    // carries its scrypt verifier. Drop it on read so it is never handed
    // around or written back, and erase it from disk.
    if (parsed.passwordHash !== undefined) {
      delete parsed.passwordHash;
      try {
        writeProfileAt(username, parsed);
      } catch {
        // A read-only data dir must not break sign-in; the field is already
        // gone from the object callers see.
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeProfile(profile: Profile): void {
  writeProfileAt(profile.username, profile);
}

function writeProfileAt(username: string, profile: Profile): void {
  // Any stray verifier from an older release dies here too, so a profile
  // touched by any normal update stops carrying one.
  delete (profile as Profile & { passwordHash?: string }).passwordHash;
  const dir = path.dirname(profilePath(username));
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.profile.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(profile, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, profilePath(username));
}

export function listProfiles(): Profile[] {
  ensureDataDirs();
  const entries = fs.readdirSync(usersRoot(), { withFileTypes: true });
  const profiles: Profile[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const profile = readProfile(entry.name);
    if (profile) profiles.push(profile);
  }
  return profiles.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getProfile(username: string): Profile | null {
  return readProfile(username);
}

export function toPublicProfile(profile: Profile): PublicProfile {
  return {
    username: profile.username,
    displayName: profile.displayName,
    avatarSlug: profile.avatarSlug,
    isAdmin: profile.role === "admin",
  };
}

export class ProfileError extends Error {}

export function createProfile(
  displayName: string,
  avatarSlug?: string,
): Profile {
  ensureDataDirs();
  const username = normalizeUsername(displayName);
  if (!USERNAME_RE.test(username)) {
    throw new ProfileError("Name must contain at least two letters or digits.");
  }
  if (readProfile(username)) {
    throw new ProfileError(`A profile named "${username}" already exists.`);
  }
  const slug =
    avatarSlug && isAnimalSlug(avatarSlug)
      ? avatarSlug
      : animalForSeed(username).slug;
  const isFirst = listProfiles().length === 0;
  const profile: Profile = {
    username,
    displayName: displayName.trim(),
    avatarSlug: slug,
    role: isFirst ? "admin" : "member",
    captureToken: crypto.randomBytes(24).toString("hex"),
    sessionEpoch: crypto.randomBytes(16).toString("hex"),
    createdAt: new Date().toISOString(),
  };
  writeProfile(profile);
  return profile;
}

export function updateProfileAvatar(
  username: string,
  avatarSlug: string,
): Profile {
  const profile = readProfile(username);
  if (!profile) throw new ProfileError(`No profile named "${username}".`);
  if (!isAnimalSlug(avatarSlug)) {
    throw new ProfileError("Choose a valid avatar.");
  }
  const updated = { ...profile, avatarSlug };
  writeProfile(updated);
  return updated;
}

/**
 * Admin-owned instance access password (`PAPERNOOK_PASSWORD`). It is the only
 * application password in public mode: visitors pass the gate once, then
 * select or create a member profile without another password.
 */
export function instancePasswordConfigured(): boolean {
  const password = process.env.PAPERNOOK_PASSWORD;
  return Boolean(password && password.length >= 16 && password.length <= 200);
}

export function verifyInstancePassword(password: string): boolean {
  const expected = process.env.PAPERNOOK_PASSWORD;
  if (!expected || expected.length < 16 || expected.length > 200 || !password) {
    return false;
  }
  const a = Buffer.from(password);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Compare against self to keep timing flat, then reject.
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

export function isAdmin(profile: Profile): boolean {
  return profile.role === "admin";
}

export function deleteProfile(username: string): void {
  const profile = readProfile(username);
  if (!profile) throw new ProfileError("Unknown profile.");

  deleteChatsByUser(username);
  deleteSharesByOwner(username);
  anonymizePapersByUser(username);
  fs.rmSync(path.join(usersRoot(), username), { recursive: true, force: true });
  rebuildIndex();

  if (profile.role === "admin") {
    const successor = listProfiles()[0];
    if (successor) {
      successor.role = "admin";
      writeProfile(successor);
    }
  }
}

export function markWizardDone(username: string): void {
  const profile = readProfile(username);
  if (!profile) throw new ProfileError("Unknown profile.");
  profile.wizardDone = true;
  writeProfile(profile);
}

/** Connect or disconnect (null) a profile's Zotero library. */
export function setZoteroConfig(
  username: string,
  zotero: ZoteroProfileConfig | null,
): Profile {
  const profile = readProfile(username);
  if (!profile) throw new ProfileError("Unknown profile.");
  if (zotero) profile.zotero = zotero;
  else delete profile.zotero;
  writeProfile(profile);
  return profile;
}

export function rotateCaptureToken(username: string): Profile {
  const profile = readProfile(username);
  if (!profile) throw new ProfileError("Unknown profile.");
  profile.captureToken = crypto.randomBytes(24).toString("hex");
  writeProfile(profile);
  return profile;
}

/** Resolve a capture token to its owning profile, timing-safely. */
export function profileForCaptureToken(token: string): Profile | null {
  if (!/^[a-f0-9]{48}$/.test(token)) return null;
  const supplied = Buffer.from(token, "hex");
  for (const profile of listProfiles()) {
    const known = Buffer.from(profile.captureToken, "hex");
    if (
      known.length === supplied.length &&
      crypto.timingSafeEqual(known, supplied)
    ) {
      return profile;
    }
  }
  return null;
}
