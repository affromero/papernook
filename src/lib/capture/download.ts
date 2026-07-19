import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch, type Response } from "undici";
import { normalizeUrl, pdfUrlFromHtml } from "./normalize";

/**
 * Polite fetching: descriptive User-Agent (arxiv policy) and a per-host
 * cooldown so bursts of captures never hammer one origin.
 */

const USER_AGENT =
  "papernook/0.1 (self-hosted paper library; +https://github.com/afromero)";
const HOST_COOLDOWN_MS = 3_000;
const MAX_PDF_BYTES = 100 * 1024 * 1024;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;

const lastFetchByHost = new Map<string, number>();

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  const [first, second] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 &&
      (second === 0 || second === 168 || second === 2 || second === 51)) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 203 && second === 0)
  );
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, "").toLowerCase();
  const version = isIP(normalized);
  if (version === 4) return isPrivateIpv4(normalized);
  if (version !== 6) return true;

  const embeddedIpv4 = normalized.match(
    /^::(?:ffff:)?(?:(\d+\.\d+\.\d+\.\d+)|([a-f\d]{1,4}):([a-f\d]{1,4}))$/,
  );
  if (embeddedIpv4) {
    if (embeddedIpv4[1]) return isPrivateIpv4(embeddedIpv4[1]);
    const first = Number.parseInt(embeddedIpv4[2], 16);
    const second = Number.parseInt(embeddedIpv4[3], 16);
    return isPrivateIpv4(
      `${first >> 8}.${first & 0xff}.${second >> 8}.${second & 0xff}`,
    );
  }
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff")
  );
}

interface PublicAddress {
  address: string;
  family: 4 | 6;
}

async function resolvePublicUrl(
  rawUrl: string,
): Promise<{ url: URL; address: PublicAddress }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CaptureError(`Not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CaptureError("Capture URLs must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new CaptureError("Capture URLs cannot include credentials.");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(hostname);
  const addresses: PublicAddress[] = family
    ? [{ address: hostname, family: family as 4 | 6 }]
    : (
        await lookup(url.hostname, { all: true, verbatim: true }).catch(() => {
          throw new CaptureError(`Could not resolve ${url.hostname}.`);
        })
      ).map(({ address, family: resolvedFamily }) => ({
        address,
        family: resolvedFamily === 6 ? 6 : 4,
      }));
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => isPrivateAddress(address))
  ) {
    throw new CaptureError(
      "Capture URLs must resolve to public internet addresses.",
    );
  }
  return { url, address: addresses[0] };
}

interface FetchedResponse {
  response: Response;
  url: string;
  close: () => Promise<void>;
}

async function politeFetch(url: string): Promise<FetchedResponse> {
  let current = await resolvePublicUrl(url);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const currentUrl = current.url.toString();
    const host = current.url.hostname;
    const last = lastFetchByHost.get(host) ?? 0;
    const wait = last + HOST_COOLDOWN_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastFetchByHost.set(host, Date.now());
    const dispatcher = new Agent({
      connect: {
        lookup: (_hostname, _options, callback) =>
          callback(null, current.address.address, current.address.family),
      },
    });
    let response: Response;
    try {
      response = await fetch(currentUrl, {
        headers: { "User-Agent": USER_AGENT },
        redirect: "manual",
        signal: AbortSignal.timeout(60_000),
        dispatcher,
      });
    } catch {
      await dispatcher.close();
      throw new CaptureError(`Fetch failed for ${currentUrl}`);
    }
    if (response.status < 300 || response.status >= 400) {
      return { response, url: currentUrl, close: () => dispatcher.close() };
    }
    const location = response.headers.get("location");
    await response.body?.cancel();
    await dispatcher.close();
    if (!location)
      throw new CaptureError("Redirect response did not include a location.");
    current = await resolvePublicUrl(new URL(location, currentUrl).toString());
  }
  throw new CaptureError(`Too many redirects (maximum ${MAX_REDIRECTS}).`);
}

export class CaptureError extends Error {}

export interface DownloadedPdf {
  bytes: Buffer;
  finalUrl: string;
  arxivId: string | null;
}

async function readBody(
  response: Response,
  maxBytes: number,
  close: () => Promise<void>,
): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    await close();
    throw new CaptureError(
      `Response is too large (limit ${Math.round(maxBytes / 1e6)} MB).`,
    );
  }
  const reader = response.body?.getReader();
  if (!reader) {
    await close();
    return Buffer.alloc(0);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new CaptureError(
          `Response is too large (limit ${Math.round(maxBytes / 1e6)} MB).`,
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
    await close();
  }
  return Buffer.concat(chunks, size);
}

function looksLikePdf(response: Response, bytes: Buffer): boolean {
  const contentType = response.headers.get("content-type") ?? "";
  return (
    contentType.includes("application/pdf") ||
    bytes.subarray(0, 5).toString("latin1") === "%PDF-"
  );
}

/** Resolve any shared URL to actual PDF bytes (content validated). */
export async function downloadPdf(input: string): Promise<DownloadedPdf> {
  let target;
  try {
    target = normalizeUrl(input);
  } catch {
    throw new CaptureError(`Not a valid URL: ${input}`);
  }

  let pdfUrl = target.url;
  if (!target.expectsPdf) {
    const {
      response: page,
      url: pageUrl,
      close,
    } = await politeFetch(target.url);
    if (!page.ok) {
      await close();
      throw new CaptureError(
        `Page fetch failed (${page.status}) for ${target.url}`,
      );
    }
    const contentType = page.headers.get("content-type") ?? "";
    if (contentType.includes("application/pdf")) {
      const bytes = await readBody(page, MAX_PDF_BYTES, close);
      if (!looksLikePdf(page, bytes)) {
        throw new CaptureError(`The fetched file is not a PDF (${pageUrl}).`);
      }
      return { bytes, finalUrl: pageUrl, arxivId: target.arxivId };
    }
    const html = (await readBody(page, MAX_HTML_BYTES, close)).toString("utf8");
    const found = pdfUrlFromHtml(html, pageUrl);
    if (!found) {
      throw new CaptureError(
        `No PDF found on that page. Share the PDF link directly, or an arxiv abstract page.`,
      );
    }
    pdfUrl = found;
  }

  const { response, url: finalUrl, close } = await politeFetch(pdfUrl);
  if (!response.ok) {
    await close();
    throw new CaptureError(
      `PDF fetch failed (${response.status}) for ${pdfUrl}`,
    );
  }
  const bytes = await readBody(response, MAX_PDF_BYTES, close);
  if (!looksLikePdf(response, bytes)) {
    throw new CaptureError(`The fetched file is not a PDF (${finalUrl}).`);
  }
  return { bytes, finalUrl, arxivId: target.arxivId };
}
