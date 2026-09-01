import { USER_AGENT } from "../download";

/**
 * Shared bits of the arXiv / Crossref metadata lookups: one polite
 * text fetch and the minimal Atom parsing both capture analysis and the
 * reference resolver need. Deliberately regex-based — the export API
 * returns tiny, well-formed feeds and pulling in an XML parser for two
 * tags is not worth it.
 */

const LOOKUP_TIMEOUT_MS = 10_000;

/** Thrown when the lookup did not complete: non-2xx, timeout, or network. */
export class LookupFailedError extends Error {
  constructor(url: string, cause: unknown) {
    super(`lookup failed: ${url}`, { cause });
    this.name = "LookupFailedError";
  }
}

/** The response body, or a `LookupFailedError` — never a silent null, so
 * callers can tell "the service said no such thing" from "no answer". */
export async function fetchText(url: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
  } catch (error) {
    throw new LookupFailedError(url, error);
  }
  if (!response.ok) throw new LookupFailedError(url, response.status);
  return response.text();
}

export function tagText(xml: string, tag: string): string {
  return xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] ?? "";
}

export function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
