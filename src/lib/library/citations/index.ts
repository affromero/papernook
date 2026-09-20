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
  type PaperMeta,
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

const importedCslSchema = z.object({
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

function parsedImportedBibtex(meta: PaperMeta): CitationMeta | null {
  if (!meta.bibtex) return null;
  try {
    const parsed = importedCslSchema.safeParse(new Cite(meta.bibtex).data[0]);
    if (!parsed.success) return null;
    const record = parsed.data;
    return {
      type: record.type ?? "document",
      authors:
        record.author ??
        meta.authors.map((literal) => ({ literal }) satisfies CitationAuthor),
      ...(record.DOI ? { DOI: record.DOI } : {}),
      ...(record["container-title"]
        ? { containerTitle: record["container-title"] }
        : {}),
      ...(record.volume ? { volume: record.volume } : {}),
      ...(record.issue ? { issue: record.issue } : {}),
      ...(record.page ? { pages: record.page } : {}),
      ...(record.publisher ? { publisher: record.publisher } : {}),
      ...(record["publisher-place"]
        ? { publisherPlace: record["publisher-place"] }
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

/** Build the canonical citation object before metadata enters the runtime. */
export function canonicalCitationMetadata(meta: PaperMeta): CitationMeta {
  const existing = citationSchema.safeParse(meta.citation);
  if (existing.success) return existing.data;
  return (
    parsedImportedBibtex(meta) ?? {
      type: "document",
      authors: meta.authors.map((literal) => ({ literal })),
      ...(meta.venue ? { containerTitle: meta.venue } : {}),
      ...(meta.sourceUrl ? { URL: meta.sourceUrl } : {}),
    }
  );
}

/** Convert canonical paper metadata to CSL. */
export function paperToCsl(paper: Paper): CslRecord {
  const id = recordId(paper);
  const citation = citationSchema.safeParse(paper.meta.citation);
  if (!citation.success)
    throw new Error(
      `Paper ${paper.slug} requires the canonical citation migration.`,
    );
  return fromCitation(paper, id, citation.data);
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
