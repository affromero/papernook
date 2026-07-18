import crypto from "node:crypto";
import { cookies } from "next/headers";
import { sessionSecret } from "../data-dir";
import { SESSION_COOKIE, verifySessionToken } from "./session";
import { requestNeedsGate } from "./exposure";

/**
 * The access gate stands in front of the whole profile picker on a public
 * instance that uses the shared instance password. Nobody sees a profile
 * name or an Add button until they prove the password; passing the gate sets
 * a short-lived signed cookie that unlocks the picker (picking a profile then
 * logs in without re-asking, and creating one is allowed).
 */

export const GATE_COOKIE = "papernook_gate";
const GATE_TTL_MS = 1000 * 60 * 30; // 30 minutes

function sign(payload: string): string {
  return crypto
    .createHmac("sha256", sessionSecret())
    .update(`gate.${payload}`)
    .digest("hex");
}

const INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

/** Signed invite: opens the gate without typing the password. */
export function createInviteToken(now = Date.now()): string {
  const expiry = now + INVITE_TTL_MS;
  return `${expiry}.${sign(`invite.${expiry}`)}`;
}

export function verifyInviteToken(token: string, now = Date.now()): boolean {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [expiryRaw, sig] = parts;
  const expected = sign(`invite.${expiryRaw}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const expiry = Number(expiryRaw);
  return Number.isFinite(expiry) && expiry >= now;
}

export function createGateToken(now = Date.now()): string {
  const expiry = now + GATE_TTL_MS;
  return `${expiry}.${sign(String(expiry))}`;
}

export function verifyGateToken(token: string, now = Date.now()): boolean {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [expiryRaw, sig] = parts;
  const expected = sign(expiryRaw);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const expiry = Number(expiryRaw);
  return Number.isFinite(expiry) && expiry >= now;
}

/**
 * Whether the picker must stay hidden behind the password prompt for this
 * request. True only in public mode with an instance password configured and
 * no valid gate cookie yet.
 */
export async function gateRequired(): Promise<boolean> {
  if (!(await requestNeedsGate())) return false;
  const store = await cookies();
  // A logged-in profile already proved the password once: switching
  // profiles never re-asks. Only fresh visitors (or after logout) see
  // the gate.
  const session = store.get(SESSION_COOKIE)?.value;
  if (session && verifySessionToken(session)) return false;
  const token = store.get(GATE_COOKIE)?.value;
  return !token || !verifyGateToken(token);
}

/** Whether the current request already carries a valid gate cookie. */
export async function gatePassed(): Promise<boolean> {
  const store = await cookies();
  const session = store.get(SESSION_COOKIE)?.value;
  if (session && verifySessionToken(session)) return true;
  const token = store.get(GATE_COOKIE)?.value;
  return Boolean(token && verifyGateToken(token));
}

export function gateCookieOptions(): {
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
    maxAge: GATE_TTL_MS / 1000,
  };
}
