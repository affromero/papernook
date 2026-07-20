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
 * common to everyone; chats and capture tokens are per-profile. Private
 * requests may use an open picker. Public requests require both the instance
 * access gate and a per-profile password so one reader cannot impersonate
 * another.
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
  /** First profile created on the instance is the admin (Sotto's owner). */
  role?: "admin" | "member";
  /** Attributes /add captures (and their starter chats) to this profile. */
  captureToken: string;
  /** Revokes every signed session when the profile is deleted and recreated. */
  sessionEpoch?: string;
  /** Scrypt password verifier. Null is allowed only for trusted private mode. */
  passwordHash: string | null;
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
    return JSON.parse(raw) as Profile;
  } catch {
    return null;
  }
}

function writeProfile(profile: Profile): void {
  const dir = path.dirname(profilePath(profile.username));
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.profile.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(profile, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, profilePath(profile.username));
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

const PASSWORD_MIN_LENGTH = 12;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;

export function validateProfilePassword(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new ProfileError(
      `Profile password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
    );
  }
  if (password.length > 200) {
    throw new ProfileError("Profile password must be at most 200 characters.");
  }
}

export function hashProfilePassword(password: string): string {
  validateProfilePassword(password);
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
    maxmem: SCRYPT_MAX_MEMORY,
  });
  return [
    "scrypt",
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

function scrypt(
  password: string,
  salt: Buffer,
  length: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      length,
      {
        N: SCRYPT_COST,
        r: SCRYPT_BLOCK_SIZE,
        p: SCRYPT_PARALLELIZATION,
        maxmem: SCRYPT_MAX_MEMORY,
      },
      (error, derived) => {
        if (error) reject(error);
        else resolve(derived);
      },
    );
  });
}

const DUMMY_PASSWORD_HASH = hashProfilePassword(
  "papernook-dummy-password-never-valid",
);

export async function verifyProfilePassword(
  profile: Profile | null,
  password: string,
): Promise<boolean> {
  const encoded = profile?.passwordHash ?? DUMMY_PASSWORD_HASH;
  const [algorithm, nRaw, rRaw, pRaw, saltRaw, hashRaw] = encoded.split("$");
  if (
    algorithm !== "scrypt" ||
    !nRaw ||
    !rRaw ||
    !pRaw ||
    !saltRaw ||
    !hashRaw
  ) {
    return false;
  }
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (
    N !== SCRYPT_COST ||
    r !== SCRYPT_BLOCK_SIZE ||
    p !== SCRYPT_PARALLELIZATION
  ) {
    return false;
  }
  try {
    const expected = Buffer.from(hashRaw, "base64url");
    const actual = await scrypt(
      password,
      Buffer.from(saltRaw, "base64url"),
      expected.length,
    );
    return Boolean(
      profile?.passwordHash &&
      password &&
      actual.length === expected.length &&
      crypto.timingSafeEqual(actual, expected),
    );
  } catch {
    return false;
  }
}

export function createProfile(
  displayName: string,
  avatarSlug?: string,
  password?: string,
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
    passwordHash: password ? hashProfilePassword(password) : null,
    createdAt: new Date().toISOString(),
  };
  writeProfile(profile);
  return profile;
}

export function setProfilePassword(
  username: string,
  password: string,
): Profile {
  const profile = readProfile(username);
  if (!profile) throw new ProfileError("Unknown profile.");
  profile.passwordHash = hashProfilePassword(password);
  profile.sessionEpoch = crypto.randomBytes(16).toString("hex");
  writeProfile(profile);
  return profile;
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
