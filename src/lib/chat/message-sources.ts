/**
 * Pure helpers behind the "Sources & related work" card under an assistant
 * message: which external works an answer links to, minus the paper that is
 * already open. Shared with the Markdown renderer, which hides links back to
 * the current paper for the same reason.
 */

export type SourceKind = "arxiv" | "doi" | "github" | "web";

export interface Source {
  url: string;
  title: string;
  kind: SourceKind;
  host: string;
}

const MAX_TITLE_CHARS = 120;

/**
 * Canonical identity of a web URL so the same work linked two ways collapses
 * to one entry: arXiv abs/pdf/versioned → `arxiv:<id>`, DOI resolvers →
 * `doi:<doi>`, everything else host + path without trailing slash or
 * fragment.
 */
export function normalizedPaperIdentity(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "arxiv.org") {
      const match = url.pathname.match(
        /^\/(?:abs|pdf)\/([^/]+?)(?:v\d+)?(?:\.pdf)?\/?$/i,
      );
      if (match?.[1]) return `arxiv:${match[1].toLowerCase()}`;
    }
    if (host === "doi.org" || host === "dx.doi.org") {
      const doi = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
      if (doi) return `doi:${doi.toLowerCase()}`;
    }
    const path = url.pathname.replace(/\/+$/, "") || "/";
    return `${host}${path}`;
  } catch {
    return null;
  }
}

export function linksToCurrentPaper(
  href: string,
  paperSourceUrl?: string,
): boolean {
  if (!paperSourceUrl) return false;
  const hrefIdentity = normalizedPaperIdentity(href);
  return (
    hrefIdentity !== null &&
    hrefIdentity === normalizedPaperIdentity(paperSourceUrl)
  );
}

export function sourceKind(url: string): SourceKind {
  const host = hostOf(url);
  if (host === "arxiv.org") return "arxiv";
  if (host === "doi.org" || host === "dx.doi.org") return "doi";
  if (host === "github.com") return "github";
  return "web";
}

/**
 * A GitHub file permalink ("/blob/<sha>/path#L1-L2") is an inline code
 * citation the answer already links beside its excerpt, not a work to
 * list; only repository-level links qualify as sources.
 */
function isRepositoryFileLink(url: string): boolean {
  if (hostOf(url) !== "github.com") return false;
  try {
    return /^\/[^/]+\/[^/]+\/(blob|tree|blame|raw)\//.test(
      new URL(url).pathname,
    );
  } catch {
    return false;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Readable stand-in for a bare URL the model did not title. */
function titleFromUrl(url: string, kind: SourceKind): string {
  const identity = normalizedPaperIdentity(url) ?? url;
  if (kind === "arxiv" && identity.startsWith("arxiv:")) {
    return `arXiv:${identity.slice("arxiv:".length)}`;
  }
  if (kind === "doi" && identity.startsWith("doi:")) {
    return `doi:${identity.slice("doi:".length)}`;
  }
  const bare = url.replace(/^https?:\/\/(?:www\.)?/i, "").replace(/\/+$/, "");
  return bare.length > MAX_TITLE_CHARS
    ? `${bare.slice(0, MAX_TITLE_CHARS - 1)}…`
    : bare;
}

/**
 * Fenced blocks, inline code, and embedded images never hold citations worth
 * surfacing: an `![alt](https://…/figure.png)` is a picture, not a source.
 */
function withoutCode(markdown: string): string {
  return markdown
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, " ");
}

/** Trailing punctuation that prose attaches to a bare URL is not part of it. */
function trimBareUrl(raw: string): string {
  let url = raw.replace(/[.,;:!?'"’”]+$/, "");
  while (url.endsWith(")") && countChar(url, "(") < countChar(url, ")")) {
    url = url.slice(0, -1).replace(/[.,;:!?'"’”]+$/, "");
  }
  return url;
}

function countChar(value: string, char: string): number {
  let count = 0;
  for (const c of value) if (c === char) count += 1;
  return count;
}

function cleanTitle(raw: string): string {
  const text = raw
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_TITLE_CHARS
    ? `${text.slice(0, MAX_TITLE_CHARS - 1)}…`
    : text;
}

const MARKDOWN_LINK_RE =
  /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)(?:\s+"[^"\n]*")?\)/g;
const BARE_URL_RE = /https?:\/\/[^\s<>()[\]]+(?:\([^\s()]*\))?[^\s<>()[\]]*/g;

/**
 * Every external work an answer points at, in order of first appearance:
 * Markdown links first (their text becomes the title), then bare URLs the
 * model left unlinked. Links to the open paper are dropped; duplicates
 * collapse to the first mention, preferring a titled one.
 */
export function collectSources(
  markdown: string,
  paperSourceUrl?: string,
): Source[] {
  const prose = withoutCode(markdown);
  const seen = new Map<string, Source>();
  const sources: Source[] = [];

  function add(url: string, title: string | null): void {
    if (!/^https?:\/\//i.test(url)) return;
    if (linksToCurrentPaper(url, paperSourceUrl)) return;
    if (isRepositoryFileLink(url)) return;
    const identity = normalizedPaperIdentity(url);
    if (!identity) return;
    const kind = sourceKind(url);
    const existing = seen.get(identity);
    const isBareTitle = title === null;
    if (existing) {
      if (!isBareTitle && existing.title === titleFromUrl(existing.url, kind)) {
        existing.title = cleanTitle(title);
      }
      return;
    }
    const source: Source = {
      url,
      title: isBareTitle ? titleFromUrl(url, kind) : cleanTitle(title),
      kind,
      host: hostOf(url),
    };
    seen.set(identity, source);
    sources.push(source);
  }

  for (const match of prose.matchAll(MARKDOWN_LINK_RE)) {
    const title = cleanTitle(match[1]);
    add(match[2], /^https?:\/\//i.test(title) ? null : title);
  }
  const linkless = prose.replace(MARKDOWN_LINK_RE, " ");
  for (const match of linkless.matchAll(BARE_URL_RE)) {
    add(trimBareUrl(match[0]), null);
  }

  return sources;
}
