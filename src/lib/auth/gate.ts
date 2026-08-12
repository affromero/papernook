import crypto from "node:crypto";
import { cookies } from "next/headers";
import { sessionSecret } from "../data-dir";
import { SESSION_COOKIE, verifySessionToken } from "./session";

/**
 * The access gate stands in front of the whole profile picker. Nobody sees a
 * profile name or an Add button until they prove the instance password;
 * passing the gate sets a short-lived signed cookie that unlocks the picker.
 * This is the instance's only credential — everyone past it is a trusted
 * member of the household, free to pick any profile.
 */

export const GATE_COOKIE = "papernook_gate";
const GATE_TTL_MS = 1000 * 60 * 15;

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
 * request. True unless the visitor already holds a valid gate or session
 * cookie.
 */
export async function gateRequired(): Promise<boolean> {
  const store = await cookies();
  // A logged-in profile already passed the gate.
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
  sameSite: "strict";
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: GATE_TTL_MS / 1000,
  };
}
