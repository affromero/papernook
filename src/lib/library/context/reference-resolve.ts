import { decodeXml, fetchText, tagText } from "@/lib/capture/arxiv/atom";
import { referenceMentionsTitle, significantWords } from "./reference-match";

/**
 * Turn a bibliography entry's text into a URL the capture pipeline can
 * ingest. Cheap and exact first — an arXiv id, a DOI, or a printed link in
 * the entry itself — then one arXiv title search whose hit must literally
 * contain the entry's title words (the same conservative rule that gates
 * "in your library"): a wrong paper landing in the inbox is worse than none.
 */

export interface ResolvedReference {
  url: string;
  /** Only known when the arXiv search supplied it; regex hits carry none. */
  title: string | null;
}

const ARXIV_ID = /\b(\d{2}(?:0[1-9]|1[0-2])\.\d{4,5})(?:v\d+)?\b/;
const DOI = /\b(10\.\d{4,9}\/[^\s"'<>,;)]+)/;
const HTTP_URL = /\bhttps?:\/\/[^\s"'<>)]+/;
const MAX_CACHE = 500;
const MAX_QUERY_CHARS = 400;

function trimTrailingPunctuation(value: string): string {
  return value.replace(/[.,;:]+$/, "");
}

/** A URL printed in the entry, or one derived from its arXiv id / DOI. */
export function referenceUrlFromText(text: string): string | null {
  const arxiv = text.match(ARXIV_ID);
  if (arxiv) return `https://arxiv.org/abs/${arxiv[1]}`;
  const doi = text.match(DOI);
  if (doi) return `https://doi.org/${trimTrailingPunctuation(doi[1])}`;
  const url = text.match(HTTP_URL);
  if (url) return trimTrailingPunctuation(url[0]);
  return null;
}

/** "Smith, J., Doe, A." — mostly surnames and initials, not a title. */
function looksLikeAuthorList(segment: string): boolean {
  const initials = (segment.match(/\b[A-Z]\.(?=[\s,]|$)/g) ?? []).length;
  return initials >= 2 && initials >= significantWords(segment).length / 2;
}

/**
 * The entry's title: a quoted span when the style quotes titles, else the
 * longest period-delimited segment that is not the author list.
 */
export function titleGuess(text: string): string | null {
  const quoted = [...text.matchAll(/["“]([^"“”]{8,}?)["”]/g)].map((m) =>
    m[1].trim(),
  );
  const candidates = quoted.length
    ? quoted
    : text.split(/(?<=[.?!])\s+|\s{2,}/).map((segment) => segment.trim());
  let best: string | null = null;
  let bestWords = 0;
  for (const candidate of candidates) {
    if (looksLikeAuthorList(candidate)) continue;
    const words = significantWords(candidate).length;
    if (words > bestWords) {
      best = candidate;
      bestWords = words;
    }
  }
  return best && bestWords >= 3 ? trimTrailingPunctuation(best) : null;
}

async function searchArxivByTitle(
  text: string,
): Promise<ResolvedReference | null> {
  const title = titleGuess(text);
  if (!title) return null;
  // Lucene syntax: neutralise operators (a colon or bracket would become a
  // field or range) but keep every word — the phrase search is positional,
  // so dropping "to"/"the" would stop it matching the real title.
  const phrase = title
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const query = encodeURIComponent(`ti:"${phrase}"`);
  const xml = await fetchText(
    `https://export.arxiv.org/api/query?search_query=${query}&max_results=3`,
  );
  for (const [, entry] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const hitTitle = decodeXml(tagText(entry, "title"));
    const id = decodeXml(tagText(entry, "id")).match(ARXIV_ID)?.[1];
    if (!id || !hitTitle || !referenceMentionsTitle(text, hitTitle)) continue;
    return { url: `https://arxiv.org/abs/${id}`, title: hitTitle };
  }
  return null;
}

/**
 * Bounded memo of every settled outcome, genuine misses included: a reader
 * hovers the same few citations repeatedly, and arXiv asks for at most one
 * query per three seconds. A lookup that did not complete (503, timeout)
 * is not an outcome: it rejects with `LookupFailedError`, stays uncached,
 * and the caller reports it as a failure the reader can retry rather than
 * as "not found". Insertion order doubles as eviction order.
 */
const cache = new Map<string, ResolvedReference | null>();

function cacheKey(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS);
}

function remember(
  key: string,
  value: ResolvedReference | null,
): ResolvedReference | null {
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
  return value;
}

export async function resolveReferenceUrl(
  text: string,
): Promise<ResolvedReference | null> {
  const key = cacheKey(text);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const direct = referenceUrlFromText(key);
  if (direct) return remember(key, { url: direct, title: null });
  return remember(key, await searchArxivByTitle(key));
}
