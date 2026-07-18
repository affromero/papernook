import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import { usersRoot, ensureDataDirs, isPublicExposure } from "../data-dir";
import { isAnimalSlug, animalForSeed } from "./avatars";

/**
 * Profiles on disk: data/users/<username>/profile.json. The shared library is
 * common to everyone; chats, reading state, and capture tokens are
 * per-profile. In private mode the picker is open (no password); with
 * PUBLIC_EXPOSURE=true every profile must have a password.
 */

export interface Profile {
  username: string;
  displayName: string;
  avatarSlug: string;
  /** First profile created on the instance is the admin (Sotto's owner). */
  role?: "admin" | "member";
  /** Attributes /add captures (and their starter chats) to this profile. */
  captureToken: string;
  /** argon2 hash; null until the profile sets a password. */
  passwordHash: string | null;
  /** True once the per-profile onboarding wizard has been completed. */
  wizardDone?: boolean;
  createdAt: string;
}

/** Shape safe to send to the browser (no token, no hash). */
export interface PublicProfile {
  username: string;
  displayName: string;
  avatarSlug: string;
  hasPassword: boolean;
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
    hasPassword: profile.passwordHash !== null,
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
    passwordHash: null,
    createdAt: new Date().toISOString(),
  };
  writeProfile(profile);
  return profile;
}

export async function setPassword(
  username: string,
  password: string,
): Promise<void> {
  const profile = readProfile(username);
  if (!profile) throw new ProfileError("Unknown profile.");
  if (password.length < 8)
    throw new ProfileError("Password must be at least 8 characters.");
  profile.passwordHash = await argon2Hash(password);
  writeProfile(profile);
}

export async function verifyPassword(
  username: string,
  password: string,
): Promise<boolean> {
  const profile = readProfile(username);
  if (!profile || profile.passwordHash === null) return false;
  try {
    return await argon2Verify(profile.passwordHash, password);
  } catch {
    return false;
  }
}

/**
 * Whether opening a profile requires a password right now. Private mode:
 * never. Public exposure: always.
 */
export function requiresPassword(): boolean {
  return isPublicExposure();
}

/**
 * Instance-level access password (PAPERNOOK_PASSWORD, e.g. from Infisical).
 * When set, it is THE password for every profile in public mode: login and
 * profile creation verify against it, and no per-profile password is ever
 * prompted for. When unset, public mode falls back to per-profile
 * passwords set on first login.
 */
export function instancePasswordConfigured(): boolean {
  return Boolean(process.env.PAPERNOOK_PASSWORD);
}

export function verifyInstancePassword(password: string): boolean {
  const expected = process.env.PAPERNOOK_PASSWORD;
  if (!expected || !password) return false;
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
  if (profile.role === "admin") {
    throw new ProfileError("The admin profile cannot be deleted.");
  }
  fs.rmSync(path.join(usersRoot(), username), { recursive: true, force: true });
}

export function markWizardDone(username: string): void {
  const profile = readProfile(username);
  if (!profile) throw new ProfileError("Unknown profile.");
  profile.wizardDone = true;
  writeProfile(profile);
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
