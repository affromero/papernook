import { z } from "zod";
import {
  getProfile,
  listProfiles,
  type ZoteroLibraryTarget,
  type ZoteroProfileConfig,
} from "../auth/users";
import { rebuildIndex } from "../library/index-db";
import {
  listPapers,
  writeMeta,
  type CitationAuthor,
  type CitationMeta,
  type CitationType,
  type Paper,
  type PaperMeta,
  type PaperSource,
} from "../library/papers";
import { MAX_PDF_BYTES } from "./download";
import { readBoundedResponse, ResponseTooLargeError } from "./bounded-response";
import {
  associationIdentity,
  catalogRecordSchema,
  emptyLibrary,
  libraryIdentity,
  MAX_CATALOG_BYTES,
  MAX_CATALOG_RECORDS,
  readZoteroCatalog,
  writeZoteroCatalog,
  type ZoteroAssociation,
  type ZoteroCatalogLibrary,
  type ZoteroCatalogRecord,
} from "./zotero-catalog";
import { profileLockKey, withZoteroLock, ZoteroBusyError } from "./zotero-lock";

/**
 * Metadata-first Zotero bridge. Scheduled work refreshes only a compact,
 * profile-private catalog. A PDF and its AI analysis enter Papernook only
 * after the profile explicitly imports one catalog item.
 */

const API = "https://api.zotero.org";
const SYNC_INTERVAL_MS = 30 * 60 * 1000;

export type ZoteroConfig = ZoteroProfileConfig;

const boundedString = z.string().max(10_000);
const permissionSchema = z
  .object({
    library: z.boolean().optional(),
    files: z.boolean().optional(),
  })
  .passthrough();
const keyResponseSchema = z.object({
  userID: z.number().int().nonnegative(),
  username: z.string().max(1_000).optional(),
  access: z
    .object({
      user: permissionSchema.optional(),
      groups: z.record(z.string(), permissionSchema).optional(),
    })
    .optional(),
});

export interface VerifiedZoteroKey {
  userId: string;
  username: string;
  personalLibrary: boolean;
  personalFiles: boolean;
}

const itemDataSchema = z.object({
  key: z.string().min(1).max(64),
  version: z.number().int().nonnegative(),
  itemType: z.string().min(1).max(64),
  parentItem: z.string().min(1).max(64).optional(),
  contentType: z.string().max(256).optional(),
  linkMode: z.string().max(64).optional(),
  filename: z.string().max(1_000).optional(),
  title: boundedString.optional(),
  creators: z
    .array(
      z.object({
        creatorType: z.string().max(64).optional(),
        name: z.string().max(1_000).optional(),
        firstName: z.string().max(1_000).optional(),
        lastName: z.string().max(1_000).optional(),
      }),
    )
    .max(500)
    .optional(),
  date: z.string().max(256).optional(),
  publicationTitle: boundedString.optional(),
  conferenceName: boundedString.optional(),
  university: boundedString.optional(),
  institution: boundedString.optional(),
  url: boundedString.optional(),
  DOI: z.string().max(1_000).optional(),
  extra: boundedString.optional(),
  volume: z.string().max(256).optional(),
  issue: z.string().max(256).optional(),
  pages: z.string().max(256).optional(),
  publisher: boundedString.optional(),
  place: boundedString.optional(),
  abstractNote: boundedString.optional(),
  language: z.string().max(256).optional(),
  ISBN: z.string().max(256).optional(),
  ISSN: z.string().max(256).optional(),
  tags: z
    .array(z.object({ tag: z.string().max(500) }))
    .max(1_000)
    .optional(),
  collections: z.array(z.string().min(1).max(64)).max(1_000).optional(),
  annotationType: z.string().max(64).optional(),
  annotationText: z.string().max(50_000).optional(),
  annotationComment: z.string().max(50_000).optional(),
  annotationColor: z.string().max(64).optional(),
  annotationPageLabel: z.string().max(256).optional(),
  annotationSortIndex: z.string().max(256).optional(),
});
type ZoteroItemData = z.infer<typeof itemDataSchema>;

const itemSchema = z.object({
  key: z.string().min(1).max(64),
  version: z.number().int().nonnegative(),
  data: itemDataSchema,
});
const collectionSchema = z.object({
  data: z.object({
    key: z.string().min(1).max(64),
    name: z.string().trim().min(1).max(1_000),
    parentCollection: z
      .union([z.string().min(1).max(64), z.literal(false)])
      .optional(),
  }),
});

const groupSchema = z.object({
  id: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]),
  data: z.object({
    name: z.string().trim().min(1).max(1_000),
  }),
});

export interface ZoteroCollectionOption {
  key: string;
  name: string;
  parentCollection: string | null;
}

export class ZoteroError extends Error {}
export class ZoteroPdfTooLargeError extends ZoteroError {}

export function targetOf(cfg: ZoteroConfig): ZoteroLibraryTarget {
  return (
    cfg.target ?? {
      type: "user",
      id: cfg.userId,
      name: "My Library",
    }
  );
}

function libraryPrefix(target: ZoteroLibraryTarget): string {
  return target.type === "user"
    ? `/users/${target.id}`
    : `/groups/${target.id}`;
}

function sortedUnique(values: string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort((a, b) => a.localeCompare(b));
}

async function apiFetch(
  apiKey: string,
  pathname: string,
  search: Record<string, string> = {},
): Promise<Response> {
  const url = new URL(`${API}${pathname}`);
  for (const [key, value] of Object.entries(search)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    headers: {
      "Zotero-API-Key": apiKey,
      "Zotero-API-Version": "3",
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new ZoteroError(`Zotero API ${response.status} for ${pathname}`);
  }
  return response;
}

async function zoteroFetch(
  cfg: ZoteroConfig,
  pathname: string,
  search: Record<string, string> = {},
): Promise<Response> {
  return apiFetch(
    cfg.apiKey,
    `${libraryPrefix(targetOf(cfg))}${pathname}`,
    search,
  );
}

/** Validate a key, discover its owner, and retain the permissions we require. */
export async function verifyKey(
  apiKey: string,
): Promise<VerifiedZoteroKey | null> {
  const response = await fetch(`${API}/keys/current`, {
    headers: {
      "Zotero-API-Key": apiKey,
      "Zotero-API-Version": "3",
    },
  });
  if (!response.ok) return null;
  const parsed = keyResponseSchema.safeParse(await response.json());
  if (!parsed.success) return null;
  return {
    userId: String(parsed.data.userID),
    username: parsed.data.username ?? "",
    personalLibrary: parsed.data.access?.user?.library === true,
    personalFiles: parsed.data.access?.user?.files === true,
  };
}

/** Personal library plus groups visible to this key. */
export async function listLibraryTargets(
  cfg: ZoteroConfig,
  includePersonal = true,
): Promise<ZoteroLibraryTarget[]> {
  const groups: z.infer<typeof groupSchema>[] = [];
  for (let start = 0; ;) {
    const response = await apiFetch(cfg.apiKey, `/users/${cfg.userId}/groups`, {
      format: "json",
      limit: "100",
      start: String(start),
    });
    const parsed = z.array(groupSchema).safeParse(await response.json());
    if (!parsed.success) {
      throw new ZoteroError("Zotero returned invalid group libraries.");
    }
    groups.push(...parsed.data);
    start += parsed.data.length;
    if (parsed.data.length < 100) break;
  }
  return [
    ...(includePersonal
      ? [{ type: "user" as const, id: cfg.userId, name: "My Library" }]
      : []),
    ...groups
      .map((group): ZoteroLibraryTarget => ({
        type: "group",
        id: String(group.id),
        name: group.data.name,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  ];
}

export async function listCollections(
  cfg: ZoteroConfig,
): Promise<ZoteroCollectionOption[]> {
  const collections: ZoteroCollectionOption[] = [];
  let snapshotVersion: number | null = null;
  for (let start = 0; ;) {
    const response = await zoteroFetch(cfg, "/collections", {
      format: "json",
      limit: "100",
      start: String(start),
    });
    const headerVersion = Number(response.headers.get("Last-Modified-Version"));
    if (Number.isInteger(headerVersion) && headerVersion >= 0) {
      if (snapshotVersion !== null && snapshotVersion !== headerVersion) {
        throw new ZoteroError(
          "Zotero changed during collection pagination; retry later.",
        );
      }
      snapshotVersion = headerVersion;
    }
    const parsed = z.array(collectionSchema).safeParse(await response.json());
    if (!parsed.success) {
      throw new ZoteroError("Zotero returned invalid collections.");
    }
    collections.push(
      ...parsed.data.map(({ data }) => ({
        key: data.key,
        name: data.name,
        parentCollection:
          typeof data.parentCollection === "string"
            ? data.parentCollection
            : null,
      })),
    );
    start += parsed.data.length;
    if (parsed.data.length < 100) break;
  }
  return collections.sort((a, b) => a.name.localeCompare(b.name));
}

async function listChangedItems(
  cfg: ZoteroConfig,
  since: number,
): Promise<{
  records: Record<string, ZoteroCatalogRecord>;
  count: number;
  version: number;
}> {
  const records: Record<string, ZoteroCatalogRecord> = {};
  let projectedBytes = 0;
  let count = 0;
  let version = since;
  let snapshotVersion: number | null = null;
  for (let start = 0; ;) {
    const response = await zoteroFetch(cfg, "/items", {
      since: String(since),
      format: "json",
      limit: "100",
      start: String(start),
    });
    const headerVersion = Number(response.headers.get("Last-Modified-Version"));
    if (Number.isInteger(headerVersion) && headerVersion >= 0) {
      if (snapshotVersion !== null && snapshotVersion !== headerVersion) {
        throw new ZoteroError(
          "Zotero changed during catalog pagination; retrying later.",
        );
      }
      snapshotVersion = headerVersion;
      version = headerVersion;
    }
    const parsed = z.array(itemSchema).safeParse(await response.json());
    if (!parsed.success) {
      throw new ZoteroError("Zotero returned invalid items.");
    }
    for (const { data } of parsed.data) {
      const record = projectRecord(data);
      if (!records[data.key]) count += 1;
      records[data.key] = record;
      projectedBytes +=
        Buffer.byteLength(JSON.stringify(record), "utf8") + data.key.length + 8;
      if (count > MAX_CATALOG_RECORDS || projectedBytes > MAX_CATALOG_BYTES) {
        throw new ZoteroError(
          "Zotero metadata exceeds the local catalog safety limit.",
        );
      }
    }
    start += parsed.data.length;
    if (parsed.data.length < 100) break;
  }
  return { records, count, version };
}

const deletedSchema = z.object({
  items: z.array(z.string().min(1).max(64)).max(200_000).default([]),
});

async function listDeletedItems(
  cfg: ZoteroConfig,
  since: number,
): Promise<{ itemKeys: string[]; version: number }> {
  const response = await zoteroFetch(cfg, "/deleted", {
    since: String(since),
  });
  const parsed = deletedSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new ZoteroError("Zotero returned invalid deletion metadata.");
  }
  const headerVersion = Number(response.headers.get("Last-Modified-Version"));
  return {
    itemKeys: parsed.data.items,
    version:
      Number.isInteger(headerVersion) && headerVersion >= 0
        ? headerVersion
        : since,
  };
}

function attachmentPriority(item: ZoteroItemData): number {
  if (item.linkMode?.startsWith("imported_")) return 0;
  if (!item.linkMode) return 1;
  return 2;
}

function orderedAttachmentKeys(items: ZoteroItemData[]): string[] {
  return [...items]
    .sort(
      (a, b) =>
        attachmentPriority(a) - attachmentPriority(b) ||
        a.key.localeCompare(b.key),
    )
    .map((item) => item.key);
}

export async function downloadAttachment(
  cfg: ZoteroConfig,
  attachmentKey: string,
): Promise<Buffer> {
  const response = await zoteroFetch(cfg, `/items/${attachmentKey}/file`);
  let bytes: Buffer;
  try {
    bytes = await readBoundedResponse(response, MAX_PDF_BYTES);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) {
      throw new ZoteroPdfTooLargeError(error.message);
    }
    throw error;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (
    !contentType.includes("application/pdf") &&
    bytes.subarray(0, 5).toString("latin1") !== "%PDF-"
  ) {
    throw new ZoteroError("Zotero attachment is not a PDF.");
  }
  return bytes;
}

function sourceMatches(
  paper: Paper,
  target: ZoteroLibraryTarget,
  username: string,
  key?: string,
): boolean {
  const source = paper.meta.source;
  if (source?.provider !== "zotero") return false;
  if (key && source.key !== key) return false;
  if (source.libraryType && source.libraryId) {
    return source.libraryType === target.type && source.libraryId === target.id;
  }
  return (
    target.type === "user" &&
    paper.meta.addedBy === username &&
    source.libraryId === undefined
  );
}

export function arxivIdOf(item: ZoteroItemData): string | null {
  const haystack = `${item.url ?? ""} ${item.extra ?? ""}`;
  const match = haystack.match(/arxiv[^0-9]{0,15}(\d{4}\.\d{4,5})/i);
  return match ? match[1] : null;
}

const TYPE_MAP: Record<string, CitationType> = {
  journalArticle: "article-journal",
  conferencePaper: "paper-conference",
  book: "book",
  bookSection: "chapter",
  thesis: "thesis",
  report: "report",
  manuscript: "manuscript",
  webpage: "webpage",
  dataset: "dataset",
  preprint: "article",
};

export function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizedDoi(value: string | undefined): string | undefined {
  const doi = value
    ?.trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "");
  return doi && /^10\.\d{4,9}\/\S+$/i.test(doi) ? doi : undefined;
}

export function citationAuthors(item: ZoteroItemData): CitationAuthor[] {
  return (item.creators ?? [])
    .filter(
      (creator) => !creator.creatorType || creator.creatorType === "author",
    )
    .map<CitationAuthor>((creator) => {
      const literal = optional(creator.name);
      if (literal) return { literal };
      const family = optional(creator.lastName);
      const given = optional(creator.firstName);
      return {
        ...(family ? { family } : {}),
        ...(given ? { given } : {}),
      };
    })
    .filter((creator) => creator.literal || creator.family || creator.given);
}

function citationOf(item: ZoteroItemData): CitationMeta {
  const DOI = normalizedDoi(item.DOI);
  const containerTitle = [
    item.publicationTitle,
    item.conferenceName,
    item.university,
  ]
    .map(optional)
    .find(Boolean);
  const publisher = [item.publisher, item.institution]
    .map(optional)
    .find(Boolean);
  const volume = optional(item.volume);
  const issue = optional(item.issue);
  const pages = optional(item.pages);
  const publisherPlace = optional(item.place);
  const abstract = optional(item.abstractNote);
  const URL = optional(item.url);
  const language = optional(item.language);
  const ISBN = optional(item.ISBN);
  const ISSN = optional(item.ISSN);
  return {
    type: TYPE_MAP[item.itemType] ?? "document",
    authors: citationAuthors(item),
    ...(DOI ? { DOI } : {}),
    ...(containerTitle ? { containerTitle } : {}),
    ...(volume ? { volume } : {}),
    ...(issue ? { issue } : {}),
    ...(pages ? { pages } : {}),
    ...(publisher ? { publisher } : {}),
    ...(publisherPlace ? { publisherPlace } : {}),
    ...(abstract ? { abstract } : {}),
    ...(URL ? { URL } : {}),
    ...(language ? { language } : {}),
    ...(ISBN ? { ISBN } : {}),
    ...(ISSN ? { ISSN } : {}),
  };
}

export function overridesOf(item: ZoteroItemData): Partial<PaperMeta> {
  const title = optional(item.title);
  const authors = citationAuthors(item).map(
    (author) =>
      author.literal ?? [author.given, author.family].filter(Boolean).join(" "),
  );
  const year = item.date?.match(/\b(\d{4})\b/);
  const venue = optional(
    item.publicationTitle ?? item.conferenceName ?? item.university,
  );
  return {
    ...(title ? { title } : {}),
    authors,
    year: year ? Number(year[1]) : null,
    venue: venue ?? null,
    citation: citationOf(item),
  };
}

export function sourceTags(item: ZoteroItemData): string[] {
  const tags = new Map<string, string>();
  for (const { tag: raw } of item.tags ?? []) {
    const tag = raw.trim();
    if (tag && !tags.has(tag.toLocaleLowerCase())) {
      tags.set(tag.toLocaleLowerCase(), tag);
    }
  }
  return [...tags.values()];
}

function collectionNamesFor(
  keys: string[],
  collections: Map<string, ZoteroCollectionOption>,
): string[] {
  return keys
    .map((key) => collections.get(key)?.name)
    .filter((name): name is string => Boolean(name))
    .sort((a, b) => a.localeCompare(b));
}

export function sourceOf(
  item: ZoteroItemData,
  target: ZoteroLibraryTarget,
  collections: Map<string, ZoteroCollectionOption>,
): PaperSource {
  const collectionKeys = sortedUnique(item.collections);
  return {
    provider: "zotero",
    key: item.key,
    version: item.version,
    libraryType: target.type,
    libraryId: target.id,
    collectionKeys,
    collections: collectionNamesFor(collectionKeys, collections),
    tags: sourceTags(item),
  };
}

function mergeRefreshedTags(
  current: string[],
  previousSourceTags: string[] | undefined,
  nextSourceTags: string[],
): string[] {
  const previous = new Set(
    (previousSourceTags ?? []).map((tag) => tag.toLocaleLowerCase()),
  );
  const merged = new Map<string, string>();
  for (const tag of current) {
    if (!previous.has(tag.toLocaleLowerCase())) {
      merged.set(tag.toLocaleLowerCase(), tag);
    }
  }
  for (const tag of nextSourceTags) {
    merged.set(tag.toLocaleLowerCase(), tag);
  }
  return [...merged.values()];
}

function refreshPaper(
  paper: Paper,
  item: ZoteroItemData,
  target: ZoteroLibraryTarget,
  collections: Map<string, ZoteroCollectionOption>,
): void {
  const overrides = overridesOf(item);
  const source = sourceOf(item, target, collections);
  writeMeta(paper.topic, paper.slug, {
    ...paper.meta,
    ...overrides,
    sourceUrl: optional(item.url) ?? paper.meta.sourceUrl,
    tags: mergeRefreshedTags(
      paper.meta.tags,
      paper.meta.source?.tags,
      source.tags ?? [],
    ),
    source,
  });
}

function expandedCollectionKeys(
  selected: string[],
  collections: Map<string, ZoteroCollectionOption>,
): Set<string> | null {
  if (selected.length === 0) return null;
  for (const key of selected) {
    if (!collections.has(key)) {
      throw new ZoteroError(
        `Selected Zotero collection ${key} is no longer accessible.`,
      );
    }
  }
  const expanded = new Set(selected);
  let changed = true;
  while (changed) {
    changed = false;
    for (const collection of collections.values()) {
      if (
        collection.parentCollection &&
        expanded.has(collection.parentCollection) &&
        !expanded.has(collection.key)
      ) {
        expanded.add(collection.key);
        changed = true;
      }
    }
  }
  return expanded;
}

function inSelectedCollections(
  item: ZoteroItemData,
  selected: Set<string> | null,
): boolean {
  if (!selected) return true;
  return (item.collections ?? []).some((key) => selected.has(key));
}

function isBibliographic(item: ZoteroItemData): boolean {
  return !["attachment", "note", "annotation"].includes(item.itemType);
}

function isPdfAttachment(item: ZoteroItemData): boolean {
  return (
    item.itemType === "attachment" && item.contentType === "application/pdf"
  );
}

function projectRecord(item: ZoteroItemData): ZoteroCatalogRecord {
  return catalogRecordSchema.parse(item);
}

export function collectionMap(
  library: ZoteroCatalogLibrary,
): Map<string, ZoteroCollectionOption> {
  return new Map(
    library.collections.map((collection) => [collection.key, collection]),
  );
}

function selectedCollections(
  cfg: ZoteroConfig,
  library: ZoteroCatalogLibrary,
): Set<string> | null {
  return expandedCollectionKeys(
    sortedUnique(cfg.collectionKeys),
    collectionMap(library),
  );
}

function isStandalonePdf(item: ZoteroCatalogRecord): boolean {
  return isPdfAttachment(item) && !item.parentItem;
}

export function visibleParentRecords(
  cfg: ZoteroConfig,
  library: ZoteroCatalogLibrary,
): ZoteroCatalogRecord[] {
  const selected = selectedCollections(cfg, library);
  return Object.values(library.records).filter(
    (item) =>
      (isBibliographic(item) || isStandalonePdf(item)) &&
      inSelectedCollections(item, selected),
  );
}

export function attachmentsFor(
  library: ZoteroCatalogLibrary,
  item: ZoteroCatalogRecord,
): ZoteroCatalogRecord[] {
  if (isStandalonePdf(item)) return [item];
  return Object.values(library.records).filter(
    (candidate) =>
      candidate.parentItem === item.key && isPdfAttachment(candidate),
  );
}

export function storedAttachmentKeys(
  library: ZoteroCatalogLibrary,
  item: ZoteroCatalogRecord,
): string[] {
  return orderedAttachmentKeys(attachmentsFor(library, item)).filter((key) => {
    const attachment = library.records[key];
    return attachment?.linkMode !== "linked_file";
  });
}

export function associationFor(
  associations: Record<string, ZoteroAssociation>,
  target: ZoteroLibraryTarget,
  itemKey: string,
): ZoteroAssociation | undefined {
  return associations[associationIdentity(target, itemKey)];
}

export function paperForAssociation(
  association: ZoteroAssociation | undefined,
): Paper | null {
  if (!association) return null;
  return (
    listPapers().find(
      (paper) =>
        paper.topic === association.topic && paper.slug === association.slug,
    ) ?? null
  );
}

export function existingPaperFor(
  username: string,
  target: ZoteroLibraryTarget,
  item: ZoteroCatalogRecord,
): Paper | null {
  const exact = listPapers().find((paper) =>
    sourceMatches(paper, target, username, item.key),
  );
  if (exact) return exact;
  const arxivId = arxivIdOf(item);
  if (arxivId) {
    const arxiv = listPapers().find((paper) => paper.meta.arxivId === arxivId);
    if (arxiv) return arxiv;
  }
  const doi = normalizedDoi(item.DOI);
  if (!doi) return null;
  return (
    listPapers().find(
      (paper) =>
        normalizedDoi(paper.meta.citation?.DOI)?.toLocaleLowerCase() ===
        doi.toLocaleLowerCase(),
    ) ?? null
  );
}

export function associate(
  catalog: Awaited<ReturnType<typeof readZoteroCatalog>>,
  target: ZoteroLibraryTarget,
  itemKey: string,
  paper: Paper,
): void {
  if (!paper.topic) {
    throw new ZoteroError("Imported Zotero paper is not filed.");
  }
  catalog.associations[associationIdentity(target, itemKey)] = {
    libraryType: target.type,
    libraryId: target.id,
    itemKey,
    topic: paper.topic,
    slug: paper.slug,
  };
}

function paperNeedsRefresh(
  paper: Paper,
  item: ZoteroCatalogRecord,
  collections: Map<string, ZoteroCollectionOption>,
): boolean {
  const source = paper.meta.source;
  if (!source) return false;
  return (
    source.version !== item.version ||
    JSON.stringify(source.collectionKeys ?? []) !==
      JSON.stringify(sortedUnique(item.collections)) ||
    JSON.stringify(source.collections ?? []) !==
      JSON.stringify(
        collectionNamesFor(sortedUnique(item.collections), collections),
      ) ||
    JSON.stringify(source.tags ?? []) !== JSON.stringify(sourceTags(item))
  );
}

function associateMaterializedPapers(
  username: string,
  target: ZoteroLibraryTarget,
  library: ZoteroCatalogLibrary,
  catalog: Awaited<ReturnType<typeof readZoteroCatalog>>,
): void {
  for (const paper of listPapers()) {
    if (!paper.topic || !sourceMatches(paper, target, username)) continue;
    const item = library.records[paper.meta.source!.key];
    if (!item || !isBibliographic(item)) continue;
    associate(catalog, target, item.key, paper);
  }
}

function refreshMaterializedPapers(
  username: string,
  target: ZoteroLibraryTarget,
  library: ZoteroCatalogLibrary,
): number {
  const collections = collectionMap(library);
  let refreshed = 0;
  for (const paper of listPapers()) {
    if (!paper.topic || !sourceMatches(paper, target, username)) continue;
    const item = library.records[paper.meta.source!.key];
    if (!item || !isBibliographic(item)) continue;
    if (!paperNeedsRefresh(paper, item, collections)) continue;
    refreshPaper(paper, item, target, collections);
    refreshed += 1;
  }
  return refreshed;
}

const inFlight = new Set<string>();

export interface ZoteroSyncResult {
  /** Scheduled refreshes never import PDFs. */
  imported: 0;
  discovered: number;
  updated: number;
  skipped: number;
  removed: number;
  available: number;
  failed: number;
}

const lastResults = new Map<string, ZoteroSyncResult>();

export function isSyncing(username: string): boolean {
  return inFlight.has(username);
}

export function lastSyncResult(username: string): ZoteroSyncResult | null {
  return lastResults.get(username) ?? null;
}

async function refreshCatalog(
  username: string,
  cfg: ZoteroConfig,
): Promise<ZoteroSyncResult> {
  const target = targetOf(cfg);
  const identity = libraryIdentity(target);
  const catalog = await readZoteroCatalog(username);
  const previous = catalog.libraries[identity] ?? emptyLibrary(target);
  const previousVisible = previous.refreshedAt
    ? visibleParentRecords(cfg, previous).length
    : 0;
  const [collections, changed, deleted] = await Promise.all([
    listCollections(cfg),
    listChangedItems(cfg, previous.lastVersion),
    listDeletedItems(cfg, previous.lastVersion),
  ]);
  const records = { ...previous.records };
  for (const key of deleted.itemKeys) delete records[key];
  Object.assign(records, changed.records);
  const safeVersion = Math.min(changed.version, deleted.version);
  const library: ZoteroCatalogLibrary = {
    target,
    lastVersion: safeVersion,
    refreshedAt: new Date().toISOString(),
    collections,
    records,
  };
  catalog.libraries[identity] = library;
  const available = visibleParentRecords(cfg, library).filter(
    (item) => storedAttachmentKeys(library, item).length > 0,
  ).length;
  associateMaterializedPapers(username, target, library, catalog);
  await writeZoteroCatalog(username, catalog);
  const refreshedPapers = refreshMaterializedPapers(username, target, library);
  if (refreshedPapers > 0) rebuildIndex();
  const visible = visibleParentRecords(cfg, library).length;
  return {
    imported: 0,
    discovered: Math.max(0, visible - previousVisible),
    updated: changed.count + refreshedPapers,
    skipped: 0,
    removed: deleted.itemKeys.length + Math.max(0, previousVisible - visible),
    available,
    failed: 0,
  };
}

/** Refresh compact metadata only; no PDF bytes or AI provider are touched. */
export async function syncProfile(
  username: string,
): Promise<ZoteroSyncResult | null> {
  const profile = getProfile(username);
  const cfg = profile?.zotero;
  if (!profile || !cfg || inFlight.has(username)) return null;
  inFlight.add(username);
  try {
    const result = await withZoteroLock(profileLockKey(username), 0, () =>
      refreshCatalog(username, cfg),
    );
    lastResults.set(username, result);
    return result;
  } catch (error) {
    if (error instanceof ZoteroBusyError) return null;
    lastResults.set(username, {
      imported: 0,
      discovered: 0,
      updated: 0,
      skipped: 0,
      removed: 0,
      available: 0,
      failed: 1,
    });
    throw error;
  } finally {
    inFlight.delete(username);
  }
}

/** Boot + every 30 min: sync every profile that connected Zotero. */
export function startZoteroSync(): () => void {
  const tick = async () => {
    for (const profile of listProfiles()) {
      if (!profile.zotero) continue;
      try {
        await syncProfile(profile.username);
      } catch (error) {
        console.error(`zotero sync failed for ${profile.username}:`, error);
      }
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), SYNC_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
