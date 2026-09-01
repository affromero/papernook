import { USER_AGENT } from "../download";

/**
 * Shared bits of the arXiv / Crossref metadata lookups: one polite
 * text fetch and the minimal Atom parsing both capture analysis and the
 * reference resolver need. Deliberately regex-based — the export API
 * returns tiny, well-formed feeds and pulling in an XML parser for two
 * tags is not worth it.
 */

const LOOKUP_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 1024 * 1024;

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
  // Metadata lookups are a few KB; stream with a byte budget so a
  // misbehaving upstream cannot pin request-handler memory with an
  // arbitrarily large 200 body.
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let part: ReadableStreamReadResult<Uint8Array>;
    try {
      part = await reader.read();
    } catch (error) {
      throw new LookupFailedError(url, error);
    }
    if (part.done) break;
    total += part.value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new LookupFailedError(url, `body over ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(part.value);
  }
  return Buffer.concat(chunks).toString("utf8");
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
