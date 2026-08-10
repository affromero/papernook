/**
 * Inline-citation pattern detection over a page's plain text. Pure and
 * deliberately permissive: anything shaped like a citation is reported, and
 * the caller gates actionability by resolving each key against the paper's
 * bibliography — a key that resolves to no entry is dropped there. That gate,
 * not this module, is what kills `[0, 1]` math intervals, `(see Smith 2020)`
 * prose look-alikes, and bracket groups in papers with author-year
 * bibliographies.
 *
 * The input text may come from the pdf.js text layer, where citations wrap
 * across lines and spans: every pattern tolerates arbitrary whitespace
 * (including newlines and NBSP) between tokens.
 */

export type CitationKey =
  | { kind: "numeric"; number: number }
  | {
      kind: "authorYear";
      surname: string;
      year: string;
      suffix: string | null;
    };

export interface InlineCitation {
  /** Offsets into the searched text, [start, end). */
  start: number;
  end: number;
  key: CitationKey;
}

/** Lowercase nobiliary particles that may precede a capitalized surname. */
const PARTICLE =
  "(?:(?:della|delle|del|den|der|des|de|dos|du|da|di|van|von|ten|ter|le|la|el|al)\\s+)*";
/**
 * One surname. The inner group re-joins hyphenated names that the text layer
 * split across a line break ("Parker-\nHolder" ⇒ "Parker- Holder"). Exported
 * as the one canonical surname pattern; bibliography.ts builds its
 * entry-head detection from it.
 */
export const NAME_PATTERN = `${PARTICLE}\\p{Lu}[\\p{L}'’]*(?:-\\s*[\\p{L}'’]+)*`;
const NAME = NAME_PATTERN;
/** "Smith", "Smith, Jones", "Smith and Jones", "Smith, Jones, & Brown". */
const NAME_LIST = `${NAME}(?:,\\s*${NAME})*(?:,?\\s+(?:and|&)\\s+${NAME})?`;
const ET_AL = "(?:\\s+et\\s+al\\.?)?";
/** Year with an optional natbib disambiguation suffix ("2025b"). */
const YEAR = "(?:19|20)\\d{2}[a-z]?(?![\\p{L}\\d])";
/** "2020" or "2020a, 2021" (multiple works by the same authors). */
const YEAR_LIST = `${YEAR}(?:\\s*,\\s*${YEAR})*`;

/** "Yang et al. 2025b", "Smith and Jones, 2024" — parenthetical/plain form. */
const ADJACENT = new RegExp(
  `(${NAME_LIST})${ET_AL},?\\s+(${YEAR_LIST})`,
  "dgu",
);
/** "Xiao et al. (2026)", "Smith (2020, 2021)" — narrative form. */
const NARRATIVE = new RegExp(
  `(${NAME_LIST})${ET_AL}\\s*\\(\\s*(${YEAR_LIST})\\s*\\)`,
  "dgu",
);
const FIRST_NAME = new RegExp(NAME, "u");
const YEAR_TOKEN = /((?:19|20)\d{2})([a-z])?/g;
/** Bracket group of citation numbers: "[12]", "[3, 5]", "[1–4, 7]". */
const BRACKET_GROUP = /\[([\d\s,;–—-]*\d[\d\s,;–—-]*)\]/g;
const BRACKET_MEMBER = /^(\d{1,3})(?:\s*[–—-]\s*\d{1,3})?$/;

function authorYearCitations(text: string, pattern: RegExp): InlineCitation[] {
  const citations: InlineCitation[] = [];
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const indices = match.indices;
    const names = match[1];
    const years = match[2];
    if (!indices?.[2] || !names || !years) continue;
    const surname = FIRST_NAME.exec(names)?.[0];
    if (!surname) continue;
    const yearsStart = indices[2][0];
    YEAR_TOKEN.lastIndex = 0;
    const yearMatches = [...years.matchAll(YEAR_TOKEN)];
    yearMatches.forEach((yearMatch, index) => {
      const year = yearMatch[1];
      if (!year) return;
      const tokenStart = yearsStart + yearMatch.index;
      const tokenEnd = tokenStart + yearMatch[0].length;
      const soleNarrative = pattern === NARRATIVE && yearMatches.length === 1;
      citations.push({
        // The first year's hotspot covers the author names too (and the
        // closing paren of a single-year narrative cite); extra years
        // ("Smith 2020, 2021") get their own token-sized hotspots.
        start: index === 0 ? match.index : tokenStart,
        end: soleNarrative ? indices[0][1] : tokenEnd,
        key: {
          kind: "authorYear",
          surname,
          year,
          suffix: yearMatch[2] ?? null,
        },
      });
    });
  }
  return citations;
}

function numericCitations(text: string): InlineCitation[] {
  const citations: InlineCitation[] = [];
  BRACKET_GROUP.lastIndex = 0;
  for (const match of text.matchAll(BRACKET_GROUP)) {
    const body = match[1];
    if (!body) continue;
    const bodyStart = match.index + 1;
    const members: { start: number; end: number; number: number }[] = [];
    let cursor = 0;
    let valid = true;
    for (const raw of body.split(/[,;]/)) {
      const start = cursor + (raw.length - raw.trimStart().length);
      const token = raw.trim();
      cursor += raw.length + 1;
      if (!token) continue;
      const member = BRACKET_MEMBER.exec(token);
      if (!member?.[1]) {
        valid = false;
        break;
      }
      members.push({
        start: bodyStart + start,
        end: bodyStart + start + token.length,
        // A range token ("1–4") gets one hotspot keyed to its first number;
        // the preview crop shows the neighboring entries anyway.
        number: Number.parseInt(member[1], 10),
      });
    }
    if (!valid) continue;
    for (const member of members) {
      citations.push({
        start: member.start,
        end: member.end,
        key: { kind: "numeric", number: member.number },
      });
    }
  }
  return citations;
}

/**
 * Find everything citation-shaped in `text`. Results are sorted by position
 * and non-overlapping (earlier match wins).
 */
export function findCitations(text: string): InlineCitation[] {
  const all = [
    ...numericCitations(text),
    ...authorYearCitations(text, NARRATIVE),
    ...authorYearCitations(text, ADJACENT),
  ].sort((a, b) => a.start - b.start || b.end - a.end);
  const citations: InlineCitation[] = [];
  let lastEnd = -1;
  for (const citation of all) {
    if (citation.start < lastEnd) continue;
    citations.push(citation);
    lastEnd = citation.end;
  }
  return citations;
}
