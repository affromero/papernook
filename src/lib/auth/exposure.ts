import { isPublicExposure } from "../data-dir";

/**
 * Public exposure is instance-wide and fails closed. Host headers are
 * attacker-controlled and must never be able to select a passwordless mode.
 */

/** Pure core, unit-testable. */
export function hostIsPublic(
  host: string | null,
  publicHost: string | undefined,
): boolean {
  if (!publicHost) return true; // exposed but unscoped: treat everything as public
  if (!host) return true;
  const bare = host.split(":")[0].toLowerCase();
  const pub = publicHost.toLowerCase();
  return bare === pub || bare === `dav-${pub}` || bare.endsWith(`.${pub}`);
}

/** Does THIS request require the public hardening (gate + password)? */
export async function requestIsPublic(): Promise<boolean> {
  return isPublicExposure();
}

/** Every public request requires the gate; missing password config fails shut. */
export async function requestNeedsGate(): Promise<boolean> {
  return requestIsPublic();
}
