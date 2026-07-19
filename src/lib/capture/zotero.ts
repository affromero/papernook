import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { usersRoot } from "../data-dir";
import { getProfile, listProfiles } from "../auth/users";
import {
  listPapers,
  type CitationAuthor,
  type CitationMeta,
  type CitationType,
  type PaperMeta,
} from "../library/papers";
import { rebuildIndex } from "../library/index-db";
import { capturePdf } from "./index";

/**
 * Pull-only Zotero sync. Each profile may connect its own Zotero library
 * (API key + user ID in profile.json); new items with a PDF attachment are
 * pulled through the regular capture pipeline and auto-filed into the
 * AI-proposed topic, flagged needsReview for after-the-fact review.
 * Incremental via Zotero's library-version protocol (?since= cursor).
 */

const API = "https://api.zotero.org";
const SYNC_INTERVAL_MS = 30 * 60 * 1000;
const CURSOR_FILE = "zotero-sync.json";

export interface ZoteroConfig {
  apiKey: string;
  userId: string;
}

const boundedString = z.string().max(10_000);
const itemDataSchema = z
  .object({
    key: z.string().min(1).max(64),
    version: z.number().int().nonnegative(),
    itemType: z.string().min(1).max(64),
    parentItem: z.string().min(1).max(64).optional(),
    contentType: z.string().max(256).optional(),
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
  }),
});

const keyResponseSchema = z.object({
  userID: z.number().int().nonnegative(),
  username: z.string().max(1_000).optional(),
});

const cursorSchema = z.object({
  lastVersion: z.number().int().nonnegative(),
  /** Zotero item key → library slug, for idempotent re-runs. */
  imported: z.record(z.string().min(1).max(64), z.string().max(1_000)),
});
type SyncCursor = z.infer<typeof cursorSchema>;

export class ZoteroError extends Error {}

async function zoteroFetch(
  cfg: ZoteroConfig,
  pathname: string,
  search: Record<string, string> = {},
): Promise<Response> {
  const url = new URL(`${API}${pathname}`);
  for (const [k, v] of Object.entries(search)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: {
      "Zotero-API-Key": cfg.apiKey,
      "Zotero-API-Version": "3",
    },
  });
  if (!res.ok) {
    throw new ZoteroError(`Zotero API ${res.status} for ${pathname}`);
  }
  return res;
}

/** Validate an API key and discover the user ID it belongs to. */
export async function verifyKey(
  apiKey: string,
): Promise<{ userId: string; username: string } | null> {
  const res = await fetch(`${API}/keys/current`, {
    headers: {
      "Zotero-API-Key": apiKey,
      "Zotero-API-Version": "3",
    },
  });
  if (!res.ok) return null;
  const parsed = keyResponseSchema.safeParse(await res.json());
  if (!parsed.success) return null;
  return {
    userId: String(parsed.data.userID),
    username: parsed.data.username ?? "",
  };
}

/**
 * Items changed since `since` that have (or are) a readable PDF attachment,
 * paired with the attachment to download, plus the new library version.
 */
export async function listNewPdfItems(
  cfg: ZoteroConfig,
  since: number,
): Promise<{
  items: { item: ZoteroItemData; attachmentKey: string }[];
  version: number;
}> {
  const changed: ZoteroItem[] = [];
  let version = since;
  for (let start = 0; ;) {
    const res = await zoteroFetch(cfg, `/users/${cfg.userId}/items`, {
      since: String(since),
      format: "json",
      limit: "100",
      start: String(start),
    });
    const headerVersion = Number(res.headers.get("Last-Modified-Version"));
    if (Number.isInteger(headerVersion) && headerVersion >= 0) {
      version = headerVersion;
    }
    const parsed = z.array(itemSchema).safeParse(await res.json());
    if (!parsed.success)
      throw new ZoteroError("Zotero returned invalid items.");
    const page: ZoteroItem[] = parsed.data;
    changed.push(...page);
    start += page.length;
    if (page.length < 100) break;
  }

  const byKey = new Map(changed.map((i) => [i.data.key, i.data]));
  const items: { item: ZoteroItemData; attachmentKey: string }[] = [];
  for (const { data } of changed) {
    if (data.itemType !== "attachment") continue;
    if (data.contentType !== "application/pdf") continue;
    if (!data.parentItem) {
      // Standalone PDF attachment: it is its own bibliographic record.
      items.push({ item: data, attachmentKey: data.key });
      continue;
    }
    let parent = byKey.get(data.parentItem);
    if (!parent) {
      // Attachment added to an item that predates the cursor.
      const res = await zoteroFetch(
        cfg,
        `/users/${cfg.userId}/items/${data.parentItem}`,
      );
      const parsed = itemSchema.safeParse(await res.json());
      if (!parsed.success)
        throw new ZoteroError("Zotero returned an invalid parent item.");
      parent = parsed.data.data;
    }
    items.push({ item: parent, attachmentKey: data.key });
  }
  return { items, version };
}

async function collectionNames(
  cfg: ZoteroConfig,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (let start = 0; ;) {
    const res = await zoteroFetch(cfg, `/users/${cfg.userId}/collections`, {
      format: "json",
      limit: "100",
      start: String(start),
    });
    const parsed = z.array(collectionSchema).safeParse(await res.json());
    if (!parsed.success)
      throw new ZoteroError("Zotero returned invalid collections.");
    for (const collection of parsed.data) {
      names.set(collection.data.key, collection.data.name.trim());
    }
    start += parsed.data.length;
    if (parsed.data.length < 100) break;
  }
  return names;
}

export async function downloadAttachment(
  cfg: ZoteroConfig,
  attachmentKey: string,
): Promise<Buffer> {
  const res = await zoteroFetch(
    cfg,
    `/users/${cfg.userId}/items/${attachmentKey}/file`,
  );
  return Buffer.from(await res.arrayBuffer());
}

function cursorPath(username: string): string {
  return path.join(usersRoot(), username, CURSOR_FILE);
}

function readCursor(username: string): SyncCursor {
  try {
    return cursorSchema.parse(
      JSON.parse(fs.readFileSync(cursorPath(username), "utf8")),
    );
  } catch {
    // Cursor lost or first run: rebuild the imported map from meta.json
    // provenance — the filesystem is the source of truth, the cursor is cache.
    const imported: Record<string, string> = {};
    for (const paper of listPapers()) {
      if (paper.meta.source?.provider === "zotero") {
        imported[paper.meta.source.key] = paper.slug;
      }
    }
    return { lastVersion: 0, imported };
  }
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
      const literal = creator.name?.trim();
      if (literal) return { literal };
      const family = creator.lastName?.trim();
      const given = creator.firstName?.trim();
      return {
        ...(family ? { family } : {}),
        ...(given ? { given } : {}),
      };
    })
    .filter((creator) => creator.literal || creator.family || creator.given);
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
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
  const overrides: Partial<PaperMeta> = { citation: citationOf(item) };
  if (item.title) overrides.title = item.title;
  const authors = (item.creators ?? [])
    .filter((c) => !c.creatorType || c.creatorType === "author")
    .map((c) => c.name ?? `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim())
    .filter(Boolean);
  if (authors.length) overrides.authors = authors;
  const year = item.date?.match(/\b(\d{4})\b/);
  if (year) overrides.year = Number(year[1]);
  if (item.publicationTitle) overrides.venue = item.publicationTitle;
  return overrides;
}

const inFlight = new Set<string>();
export interface ZoteroSyncResult {
  imported: number;
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

/**
 * Pull new PDF items for one profile. Returns null when the profile has no
 * Zotero config or a sync is already running; otherwise counts.
 */
export async function syncProfile(
  username: string,
): Promise<ZoteroSyncResult | null> {
  const profile = getProfile(username); // validates username before path use
  const cfg = profile?.zotero;
  if (!profile || !cfg) return null;
  if (inFlight.has(username)) return null;
  inFlight.add(username);
  try {
    const cursor = readCursor(username);
    const { items, version } = await listNewPdfItems(cfg, cursor.lastVersion);
    const collections = items.length ? await collectionNames(cfg) : new Map();
    const knownArxiv = new Set(
      listPapers()
        .map((p) => p.meta.arxivId)
        .filter(Boolean),
    );
    let imported = 0;
    let skipped = 0;
    let failed = 0;
    for (const { item, attachmentKey } of items) {
      if (Object.hasOwn(cursor.imported, item.key)) {
        skipped += 1;
        continue;
      }
      const arxivId = arxivIdOf(item);
      if (arxivId && knownArxiv.has(arxivId)) {
        // Same paper already in the shared library (e.g. another profile's
        // sync or a manual capture); record it so we never retry.
        cursor.imported[item.key] = "";
        skipped += 1;
        continue;
      }
      try {
        const bytes = await downloadAttachment(cfg, attachmentKey);
        const result = await capturePdf(bytes, {
          sourceUrl:
            item.url ||
            `https://www.zotero.org/users/${cfg.userId}/items/${item.key}`,
          username,
          arxivId,
          autoFile: true,
          source: {
            provider: "zotero",
            key: item.key,
            version: item.version,
            collections: [...new Set(item.collections ?? [])]
              .map((key) => collections.get(key))
              .filter((name): name is string => Boolean(name))
              .sort((a, b) => a.localeCompare(b)),
          },
          overrides: overridesOf(item),
          sourceTags: (item.tags ?? []).map(({ tag }) => tag),
        });
        cursor.imported[item.key] = result.slug;
        if (arxivId) knownArxiv.add(arxivId);
        imported += 1;
      } catch (error) {
        // Leave the item out of the cursor map so the next tick retries it.
        console.error(
          `zotero sync: item ${item.key} failed for ${username}:`,
          error,
        );
        failed += 1;
      }
    }
    if (failed === 0) cursor.lastVersion = version;
    writeCursor(username, cursor);
    if (imported > 0) rebuildIndex();
    const result = { imported, skipped, failed };
    lastResults.set(username, result);
    return result;
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
