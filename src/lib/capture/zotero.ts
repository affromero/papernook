import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  getProfile,
  listProfiles,
  type ZoteroLibraryTarget,
  type ZoteroProfileConfig,
} from "../auth/users";
import { usersRoot } from "../data-dir";
import { beginProfileActivity } from "../auth/profile-activity";
import { rebuildIndex } from "../library/index-db";
import {
  companionDir,
  exercisesPdfPath,
  listPapers,
  pdfPath,
  readMeta,
  writeMeta,
  type CitationAuthor,
  type CitationMeta,
  type CitationType,
  type Paper,
  type PaperMeta,
  type PaperSource,
} from "../library/papers";
import { capturePdf } from "./index";

// Pull-only sync: captures PDFs, then refreshes only Zotero-owned metadata.

const API = "https://api.zotero.org";
const SYNC_INTERVAL_MS = 30 * 60 * 1000;
const CURSOR_FILE = "zotero-sync.json";

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

const itemDataSchema = z
  .object({
    key: z.string().min(1).max(64),
    version: z.number().int().nonnegative(),
    itemType: z.string().min(1).max(64),
    parentItem: z.string().min(1).max(64).optional(),
    contentType: z.string().max(256).optional(),
    linkMode: z.string().max(64).optional(),
    title: boundedString.optional(),
    creators: z
      .array(
        z
          .object({
            creatorType: z.string().max(64).optional(),
            name: z.string().max(1_000).optional(),
            firstName: z.string().max(1_000).optional(),
            lastName: z.string().max(1_000).optional(),
          })
          .passthrough(),
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
      .array(z.object({ tag: z.string().max(500) }).passthrough())
      .max(1_000)
      .optional(),
    collections: z.array(z.string().min(1).max(64)).max(1_000).optional(),
  })
  .passthrough();
type ZoteroItemData = z.infer<typeof itemDataSchema>;

const itemSchema = z.object({
  key: z.string().min(1).max(64),
  version: z.number().int().nonnegative(),
  data: itemDataSchema,
});
type ZoteroItem = z.infer<typeof itemSchema>;

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

const cursorScopeSchema = z.object({
  libraryType: z.enum(["user", "group"]),
  libraryId: z.string().regex(/^\d+$/),
  collectionKeys: z.array(z.string().min(1).max(64)).max(1_000),
});
type CursorScope = z.infer<typeof cursorScopeSchema>;

const cursorSchema = z.object({
  scope: cursorScopeSchema,
  lastVersion: z.number().int().nonnegative(),
  imported: z.record(z.string().min(1).max(64), z.string().max(1_000)),
});
type SyncCursor = z.infer<typeof cursorSchema>;

const legacyCursorSchema = cursorSchema.omit({ scope: true });

export class ZoteroError extends Error {}

function targetOf(cfg: ZoteroConfig): ZoteroLibraryTarget {
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

function scopeOf(cfg: ZoteroConfig): CursorScope {
  const target = targetOf(cfg);
  return {
    libraryType: target.type,
    libraryId: target.id,
    collectionKeys: sortedUnique(cfg.collectionKeys),
  };
}

function sameScope(a: CursorScope, b: CursorScope): boolean {
  return (
    a.libraryType === b.libraryType &&
    a.libraryId === b.libraryId &&
    a.collectionKeys.length === b.collectionKeys.length &&
    a.collectionKeys.every((key, index) => key === b.collectionKeys[index])
  );
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
  for (let start = 0; ;) {
    const response = await zoteroFetch(cfg, "/collections", {
      format: "json",
      limit: "100",
      start: String(start),
    });
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
): Promise<{ items: ZoteroItem[]; version: number }> {
  const items: ZoteroItem[] = [];
  let version = since;
  for (let start = 0; ;) {
    const response = await zoteroFetch(cfg, "/items", {
      since: String(since),
      format: "json",
      limit: "100",
      start: String(start),
    });
    const headerVersion = Number(response.headers.get("Last-Modified-Version"));
    if (Number.isInteger(headerVersion) && headerVersion >= 0) {
      version = headerVersion;
    }
    const parsed = z.array(itemSchema).safeParse(await response.json());
    if (!parsed.success) {
      throw new ZoteroError("Zotero returned invalid items.");
    }
    items.push(...parsed.data);
    start += parsed.data.length;
    if (parsed.data.length < 100) break;
  }
  return { items, version };
}

async function getItem(
  cfg: ZoteroConfig,
  itemKey: string,
): Promise<ZoteroItemData> {
  const response = await zoteroFetch(cfg, `/items/${itemKey}`);
  const parsed = itemSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new ZoteroError("Zotero returned an invalid item.");
  }
  return parsed.data.data;
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

async function pdfChildKeys(
  cfg: ZoteroConfig,
  parentKey: string,
): Promise<string[]> {
  const response = await zoteroFetch(cfg, `/items/${parentKey}/children`, {
    format: "json",
  });
  const parsed = z.array(itemSchema).safeParse(await response.json());
  if (!parsed.success) {
    throw new ZoteroError("Zotero returned invalid child items.");
  }
  return orderedAttachmentKeys(
    parsed.data
      .map(({ data }) => data)
      .filter(
        (data) =>
          data.itemType === "attachment" &&
          data.contentType === "application/pdf",
      ),
  );
}

export async function downloadAttachment(
  cfg: ZoteroConfig,
  attachmentKey: string,
): Promise<Buffer> {
  const response = await zoteroFetch(cfg, `/items/${attachmentKey}/file`);
  return Buffer.from(await response.arrayBuffer());
}

function cursorPath(username: string): string {
  return path.join(usersRoot(), username, CURSOR_FILE);
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

function rebuildImported(
  username: string,
  target: ZoteroLibraryTarget,
): Record<string, string> {
  const imported: Record<string, string> = {};
  for (const paper of listPapers()) {
    if (sourceMatches(paper, target, username)) {
      imported[paper.meta.source!.key] = paper.slug;
    }
  }
  return imported;
}

function readCursor(username: string, cfg: ZoteroConfig): SyncCursor {
  const expectedScope = scopeOf(cfg);
  try {
    const raw: unknown = JSON.parse(
      fs.readFileSync(cursorPath(username), "utf8"),
    );
    const current = cursorSchema.safeParse(raw);
    if (current.success && sameScope(current.data.scope, expectedScope)) {
      return current.data;
    }
    const hasScope =
      typeof raw === "object" && raw !== null && Object.hasOwn(raw, "scope");
    const legacy = hasScope
      ? { success: false as const }
      : legacyCursorSchema.safeParse(raw);
    if (
      legacy.success &&
      expectedScope.libraryType === "user" &&
      expectedScope.libraryId === cfg.userId &&
      expectedScope.collectionKeys.length === 0
    ) {
      return { ...legacy.data, scope: expectedScope };
    }
  } catch {
    // The cursor is a cache; filesystem provenance below remains authoritative.
  }
  return {
    scope: expectedScope,
    lastVersion: 0,
    imported: rebuildImported(username, targetOf(cfg)),
  };
}

function writeCursor(username: string, cursor: SyncCursor): void {
  const file = cursorPath(username);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cursor, null, 2));
  fs.renameSync(tmp, file);
}

function arxivIdOf(item: ZoteroItemData): string | null {
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

function optional(value: string | undefined): string | undefined {
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

function citationAuthors(item: ZoteroItemData): CitationAuthor[] {
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

function overridesOf(item: ZoteroItemData): Partial<PaperMeta> {
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

function sourceTags(item: ZoteroItemData): string[] {
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

function sourceOf(
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

const inFlight = new Set<string>();
const cancelled = new Set<string>();
export interface ZoteroSyncResult {
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
}

const lastResults = new Map<string, ZoteroSyncResult>();

export function isSyncing(username: string): boolean {
  return inFlight.has(username);
}

export function lastSyncResult(username: string): ZoteroSyncResult | null {
  return lastResults.get(username) ?? null;
}

/** Stop and forget transient sync state before a profile is erased. */
export function cancelProfileSync(username: string): void {
  if (inFlight.has(username)) cancelled.add(username);
  else cancelled.delete(username);
  lastResults.delete(username);
}

function removeCancelledImport(
  username: string,
  topic: string,
  slug: string,
  sourceKey: string,
): void {
  const meta = readMeta(topic, slug);
  if (
    meta?.addedBy !== username ||
    meta.source?.provider !== "zotero" ||
    meta.source.key !== sourceKey
  ) {
    return;
  }
  fs.rmSync(pdfPath(topic, slug), { force: true });
  fs.rmSync(exercisesPdfPath(topic, slug), { force: true });
  fs.rmSync(companionDir(topic, slug), { recursive: true, force: true });
}

/** Pull the selected library, or null when disconnected/already syncing. */
export async function syncProfile(
  username: string,
): Promise<ZoteroSyncResult | null> {
  const profile = getProfile(username);
  const cfg = profile?.zotero;
  if (!profile || !cfg || inFlight.has(username)) return null;
  const config: ZoteroConfig = cfg;
  const activity = beginProfileActivity(username);
  if (!activity) return null;
  const profileActivity = activity;
  const syncCancelled = () =>
    cancelled.has(username) || profileActivity.cancelled();
  cancelled.delete(username);
  inFlight.add(username);
  try {
    const target = targetOf(cfg);
    const cursor = readCursor(username, cfg);
    const collectionList = await listCollections(cfg);
    if (syncCancelled()) return null;
    const collections = new Map(
      collectionList.map((collection) => [collection.key, collection]),
    );
    const selected = expandedCollectionKeys(
      cursor.scope.collectionKeys,
      collections,
    );
    const { items, version } = await listChangedItems(cfg, cursor.lastVersion);
    if (syncCancelled()) return null;
    const changedByKey = new Map(items.map(({ data }) => [data.key, data]));
    const changedAttachments = new Map<string, ZoteroItemData[]>();
    for (const { data } of items) {
      if (
        data.itemType === "attachment" &&
        data.contentType === "application/pdf" &&
        data.parentItem
      ) {
        const attachments = changedAttachments.get(data.parentItem) ?? [];
        attachments.push(data);
        changedAttachments.set(data.parentItem, attachments);
      }
    }

    const knownArxiv = new Set(
      listPapers()
        .map((paper) => paper.meta.arxivId)
        .filter(Boolean),
    );
    const processed = new Set<string>();
    let imported = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;

    async function processItem(
      item: ZoteroItemData,
      attachmentKeys?: string[],
    ): Promise<boolean> {
      if (syncCancelled()) return false;
      if (processed.has(item.key)) return true;
      processed.add(item.key);
      try {
        const currentPaper = listPapers().find((paper) =>
          sourceMatches(paper, target, username, item.key),
        );
        if (currentPaper) {
          if (syncCancelled()) return false;
          refreshPaper(currentPaper, item, target, collections);
          cursor.imported[item.key] = currentPaper.slug;
          updated += 1;
          return true;
        }
        if (cursor.imported[item.key] === "") {
          skipped += 1;
          return true;
        }
        if (Object.hasOwn(cursor.imported, item.key)) {
          delete cursor.imported[item.key];
        }
        if (!inSelectedCollections(item, selected)) {
          skipped += 1;
          return true;
        }
        const pdfKeys =
          attachmentKeys ??
          (cursor.lastVersion > 0 ? await pdfChildKeys(config, item.key) : []);
        if (syncCancelled()) return false;
        if (pdfKeys.length === 0) {
          skipped += 1;
          return true;
        }
        const arxivId = arxivIdOf(item);
        if (arxivId && knownArxiv.has(arxivId)) {
          cursor.imported[item.key] = "";
          skipped += 1;
          return true;
        }
        let bytes: Buffer | null = null;
        let lastDownloadError: unknown = new ZoteroError(
          "No downloadable Zotero PDF attachment.",
        );
        for (const pdfKey of pdfKeys) {
          try {
            bytes = await downloadAttachment(config, pdfKey);
            if (syncCancelled()) return false;
            break;
          } catch (error) {
            lastDownloadError = error;
          }
        }
        if (!bytes) throw lastDownloadError;
        const result = await capturePdf(
          bytes,
          {
            sourceUrl:
              optional(item.url) ??
              `https://www.zotero.org/${target.type === "user" ? "users" : "groups"}/${target.id}/items/${item.key}`,
            username,
            arxivId,
            autoFile: true,
            source: sourceOf(item, target, collections),
            overrides: overridesOf(item),
            sourceTags: sourceTags(item),
          },
          profileActivity,
        );
        if (syncCancelled()) {
          removeCancelledImport(
            username,
            result.proposedTopic,
            result.slug,
            item.key,
          );
          return false;
        }
        cursor.imported[item.key] = result.slug;
        if (arxivId) knownArxiv.add(arxivId);
        imported += 1;
        return true;
      } catch (error) {
        if (syncCancelled()) return false;
        console.error(
          `zotero sync: item ${item.key} failed for ${username}:`,
          error,
        );
        failed += 1;
        return true;
      }
    }

    const parentKeys = new Set<string>();
    for (const { data } of items) {
      if (isBibliographic(data)) parentKeys.add(data.key);
      if (data.parentItem) parentKeys.add(data.parentItem);
      if (
        data.itemType === "attachment" &&
        data.contentType === "application/pdf" &&
        !data.parentItem
      ) {
        if (!(await processItem(data, [data.key]))) return null;
      }
    }

    for (const parentKey of [...parentKeys].sort()) {
      if (syncCancelled()) return null;
      try {
        const parent =
          changedByKey.get(parentKey) ?? (await getItem(cfg, parentKey));
        if (syncCancelled()) return null;
        if (!isBibliographic(parent)) continue;
        const attachments = changedAttachments.get(parentKey);
        if (
          !(await processItem(
            parent,
            attachments ? orderedAttachmentKeys(attachments) : undefined,
          ))
        ) {
          return null;
        }
      } catch (error) {
        if (syncCancelled()) return null;
        console.error(
          `zotero sync: parent ${parentKey} failed for ${username}:`,
          error,
        );
        failed += 1;
      }
    }

    for (const paper of listPapers()) {
      if (syncCancelled()) return null;
      if (
        processed.has(paper.meta.source?.key ?? "") ||
        !sourceMatches(paper, target, username)
      ) {
        continue;
      }
      const source = paper.meta.source!;
      const collectionKeys = source.collectionKeys ?? [];
      const names = collectionNamesFor(collectionKeys, collections);
      if (
        JSON.stringify(names) !== JSON.stringify(source.collections ?? []) ||
        source.libraryType === undefined ||
        source.libraryId === undefined
      ) {
        writeMeta(paper.topic, paper.slug, {
          ...paper.meta,
          source: {
            ...source,
            libraryType: target.type,
            libraryId: target.id,
            collections: names,
          },
        });
        updated += 1;
      }
    }

    if (syncCancelled()) return null;
    if (failed === 0) cursor.lastVersion = version;
    writeCursor(username, cursor);
    if (imported > 0 || updated > 0) rebuildIndex();
    const result = { imported, updated, skipped, failed };
    lastResults.set(username, result);
    return result;
  } finally {
    inFlight.delete(username);
    cancelled.delete(username);
    profileActivity.finish();
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
