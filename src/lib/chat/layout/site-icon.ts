/** Strip page paths, credentials and query strings from provider site icons. */
export function siteIconSite(
  value: string,
): { origin: string; host: string } | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === "https:")
      return { origin: url.origin, host: url.hostname };
  } catch {
    // Invalid provider values remain unavailable icons.
  }
  return undefined;
}
