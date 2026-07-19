import { headers } from "next/headers";
import { isPublicExposure } from "../data-dir";

/**
 * Request-aware exposure: the same instance can be reached through the
 * public domain (password gate applies) and through private paths such as
 * localhost, a tunnel, or a tailnet address (no gate). Trust is decided by
 * the Host the request arrived on. Spoofing is not a concern once the app
 * ports bind to loopback: reaching the app at all then means either coming
 * through Caddy (Host is the public domain) or being on the box/tailnet.
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
  if (!isPublicExposure()) return false;
  const store = await headers();
  return hostIsPublic(
    store.get("host"),
    process.env.PAPERNOOK_PUBLIC_HOST || undefined,
  );
}

/** Every public request requires the gate; missing password config fails shut. */
export async function requestNeedsGate(): Promise<boolean> {
  return requestIsPublic();
}
