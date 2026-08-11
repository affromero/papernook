/**
 * Proxies between the reader and the PDF route may weaken the strong etags
 * the server issues: Cloudflare rewrites `"x"` to `W/"x"` on responses it
 * compresses (the small JSON save response — the PDF bytes and the body-less
 * HEAD stay strong). The origin only ever issues strong sha256 etags, so the
 * weak marker carries no information here; stripping it makes save-version
 * comparisons proxy-proof and keeps If-Match in the strong form the server
 * validates.
 */
export function normalizeEtag(raw: string | null): string | null {
  if (!raw) return null;
  return raw.startsWith("W/") ? raw.slice(2) : raw;
}
