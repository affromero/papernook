import crypto from "node:crypto";
import { cookies } from "next/headers";
import { sessionSecret } from "../data-dir";
import { getProfile, type Profile } from "./users";

/**
 * Cookie sessions include the profile's on-disk epoch. Deleting and recreating
 * the same username therefore invalidates every old device session.
 */

export const SESSION_COOKIE = "papernook_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 90; // 90 days

function sign(payload: string): string {
  return crypto
    .createHmac("sha256", sessionSecret())
    .update(payload)
    .digest("hex");
}

function sessionEpoch(profile: Profile): string {
  return (
    profile.sessionEpoch ??
    crypto
      .createHash("sha256")
      .update(profile.createdAt)
      .digest("hex")
      .slice(0, 32)
  );
}

export function createSessionToken(username: string, now = Date.now()): string {
  const profile = getProfile(username);
  if (!profile) throw new Error(`Cannot create a session for ${username}.`);
  const expiry = now + SESSION_TTL_MS;
  const payload = `${username}.${expiry}.${sessionEpoch(profile)}`;
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(
  token: string,
  now = Date.now(),
): string | null {
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [username, expiryRaw, epoch, sig] = parts;
  const payload = `${username}.${expiryRaw}.${epoch}`;
  const expected = sign(payload);
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (
    sigBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(sigBuf, expectedBuf)
  ) {
    return null;
  }
  const expiry = Number(expiryRaw);
  if (!Number.isFinite(expiry) || expiry < now) return null;
  const profile = getProfile(username);
  if (!profile || epoch !== sessionEpoch(profile)) return null;
  return username;
}

/** The active profile for the current request, or null when signed out. */
export async function activeProfile(): Promise<Profile | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const username = verifySessionToken(token);
  if (!username) return null;
  return getProfile(username);
}

export function sessionCookieOptions(): {
  httpOnly: boolean;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  };
}
