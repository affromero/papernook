import { createHash } from "node:crypto";
import { z } from "zod";
import { Cite } from "@citation-js/core";
import "@citation-js/plugin-bibtex";
import "@citation-js/plugin-csl";
import "@citation-js/plugin-ris";
import {
  CITATION_TYPES,
  type CitationAuthor,
  type CitationMeta,
  type Paper,
} from "../papers";

export const CITATION_FORMATS = [
  "csl-json",
  "ris",
  "bibtex",
  "apa",
  "harvard",
  "vancouver",
] as const;
export type CitationFormat = (typeof CITATION_FORMATS)[number];

const BIBLIOGRAPHY_STYLES = {
  apa: "apa",
  harvard: "harvard1",
  vancouver: "vancouver",
} as const;

const authorSchema = z
  .object({
    family: z.string().min(1).max(1_000).optional(),
    given: z.string().min(1).max(1_000).optional(),
    literal: z.string().min(1).max(1_000).optional(),
  })
  .refine((author) => author.family || author.given || author.literal);

const citationSchema = z.object({
  type: z.enum(CITATION_TYPES),
  authors: z.array(authorSchema).max(500),
  DOI: z.string().max(1_000).optional(),
  containerTitle: z.string().max(10_000).optional(),
  volume: z.string().max(256).optional(),
  issue: z.string().max(256).optional(),
  pages: z.string().max(256).optional(),
  publisher: z.string().max(10_000).optional(),
  publisherPlace: z.string().max(10_000).optional(),
  abstract: z.string().max(100_000).optional(),
  URL: z.string().max(10_000).optional(),
  language: z.string().max(256).optional(),
  ISBN: z.string().max(256).optional(),
  ISSN: z.string().max(256).optional(),
});

const legacyCslSchema = z.object({
  type: z.enum(CITATION_TYPES).optional(),
  title: z.string().min(1).max(10_000).optional(),
  author: z.array(authorSchema).max(500).optional(),
  issued: z
    .object({
      "date-parts": z.array(z.array(z.number().int()).min(1)).min(1),
    })
    .optional(),
  DOI: z.string().max(1_000).optional(),
  "container-title": z.string().max(10_000).optional(),
  volume: z.string().max(256).optional(),
  issue: z.string().max(256).optional(),
  page: z.string().max(256).optional(),
  publisher: z.string().max(10_000).optional(),
  "publisher-place": z.string().max(10_000).optional(),
  abstract: z.string().max(100_000).optional(),
  URL: z.string().max(10_000).optional(),
  language: z.string().max(256).optional(),
  ISBN: z.string().max(256).optional(),
  ISSN: z.string().max(256).optional(),
});

export interface CslRecord {
  id: string;
  "citation-key": string;
  type: string;
  title: string;
  author: CitationAuthor[];
  issued?: { "date-parts": number[][] };
  DOI?: string;
  "container-title"?: string;
  volume?: string;
  issue?: string;
  page?: string;
  publisher?: string;
  "publisher-place"?: string;
  abstract?: string;
  URL?: string;
  language?: string;
  ISBN?: string;
  ISSN?: string;
}

function recordId(paper: Paper): string {
  const identity = `${paper.topic ?? "inbox"}/${paper.slug}`;
  const readable = identity.replaceAll(/[^a-zA-Z0-9]/g, "_").slice(0, 48);
  const digest = createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 10);
  return `${readable}_${digest}`;
}

function fromCitation(
  paper: Paper,
  id: string,
  citation: CitationMeta,
): CslRecord {
  return {
    id,
    "citation-key": id,
    type: citation.type,
    title: paper.meta.title,
    author: citation.authors,
    ...(paper.meta.year
      ? { issued: { "date-parts": [[paper.meta.year]] } }
      : {}),
    ...(citation.DOI ? { DOI: citation.DOI } : {}),
    ...(citation.containerTitle
      ? { "container-title": citation.containerTitle }
      : {}),
    ...(citation.volume ? { volume: citation.volume } : {}),
    ...(citation.issue ? { issue: citation.issue } : {}),
    ...(citation.pages ? { page: citation.pages } : {}),
    ...(citation.publisher ? { publisher: citation.publisher } : {}),
    ...(citation.publisherPlace
      ? { "publisher-place": citation.publisherPlace }
      : {}),
    ...(citation.abstract ? { abstract: citation.abstract } : {}),
    ...(citation.URL ? { URL: citation.URL } : {}),
    ...(citation.language ? { language: citation.language } : {}),
    ...(citation.ISBN ? { ISBN: citation.ISBN } : {}),
    ...(citation.ISSN ? { ISSN: citation.ISSN } : {}),
  };
}

function parsedLegacyBibtex(paper: Paper, id: string): CslRecord | null {
  if (!paper.meta.bibtex) return null;
  try {
    const parsed = legacyCslSchema.safeParse(
      new Cite(paper.meta.bibtex).data[0],
    );
    if (!parsed.success) return null;
    const record = parsed.data;
    return {
      id,
      "citation-key": id,
      type: record.type ?? "document",
      title: record.title ?? paper.meta.title,
      author:
        record.author ??
        paper.meta.authors.map(
          (literal) => ({ literal }) satisfies CitationAuthor,
        ),
      ...(record.issued
        ? { issued: record.issued }
        : paper.meta.year
          ? { issued: { "date-parts": [[paper.meta.year]] } }
          : {}),
      ...(record.DOI ? { DOI: record.DOI } : {}),
      ...(record["container-title"]
        ? { "container-title": record["container-title"] }
        : {}),
      ...(record.volume ? { volume: record.volume } : {}),
      ...(record.issue ? { issue: record.issue } : {}),
      ...(record.page ? { page: record.page } : {}),
      ...(record.publisher ? { publisher: record.publisher } : {}),
      ...(record["publisher-place"]
        ? { "publisher-place": record["publisher-place"] }
        : {}),
      ...(record.abstract ? { abstract: record.abstract } : {}),
      ...(record.URL ? { URL: record.URL } : {}),
      ...(record.language ? { language: record.language } : {}),
      ...(record.ISBN ? { ISBN: record.ISBN } : {}),
      ...(record.ISSN ? { ISSN: record.ISSN } : {}),
    };
  } catch {
    return null;
  }
}

/** Canonical citation > legacy BibTeX > safe top-level display metadata. */
export function paperToCsl(paper: Paper): CslRecord {
  const id = recordId(paper);
  const citation = citationSchema.safeParse(paper.meta.citation);
  if (citation.success) return fromCitation(paper, id, citation.data);

  const legacy = parsedLegacyBibtex(paper, id);
  if (legacy) return legacy;

  return {
    id,
    "citation-key": id,
    type: "document",
    title: paper.meta.title,
    author: paper.meta.authors.map((literal) => ({ literal })),
    ...(paper.meta.year
      ? { issued: { "date-parts": [[paper.meta.year]] } }
      : {}),
    ...(paper.meta.venue ? { "container-title": paper.meta.venue } : {}),
    ...(paper.meta.sourceUrl ? { URL: paper.meta.sourceUrl } : {}),
  };
}

function records(papers: Paper[]): CslRecord[] {
  return [...papers]
    .sort((a, b) =>
      `${a.topic}/${a.slug}`.localeCompare(`${b.topic}/${b.slug}`),
    )
    .map(paperToCsl);
}

export function exportCitations(
  papers: Paper[],
  format: CitationFormat,
): string {
  const data = records(papers);
  if (format === "csl-json") return `${JSON.stringify(data, null, 2)}\n`;
  if (data.length === 0) return "";

  const cite = new Cite(structuredClone(data));
  if (format in BIBLIOGRAPHY_STYLES) {
    const style =
      BIBLIOGRAPHY_STYLES[format as keyof typeof BIBLIOGRAPHY_STYLES];
    return cite
      .format("bibliography", {
        format: "text",
        style,
        lang: "en-US",
      })
      .trim();
  }
  return cite.format(format);
}

export function citationContentType(format: CitationFormat): string {
  if (format === "csl-json") return "application/vnd.citationstyles.csl+json";
  if (format === "ris") return "application/x-research-info-systems";
  if (format === "bibtex") return "application/x-bibtex";
  return "text/plain";
}

export function citationExtension(format: CitationFormat): string {
  if (format === "csl-json") return "json";
  if (format === "bibtex") return "bib";
  if (format in BIBLIOGRAPHY_STYLES) return "txt";
  return "ris";
}
