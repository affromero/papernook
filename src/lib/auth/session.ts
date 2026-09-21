import { ACCESS_COOKIE, requestIdentity } from "./access";
import type { Profile } from "./users";

export const SESSION_COOKIE = ACCESS_COOKIE;

/** Resolve a persisted Sidedoor session to its selected Papernook profile. */
export async function verifySessionToken(
  token: string,
): Promise<string | null> {
  return (await requestIdentity(token))?.profile?.username ?? null;
}

export async function activeProfile(): Promise<Profile | null> {
  return (await requestIdentity())?.profile ?? null;
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
  };
}
