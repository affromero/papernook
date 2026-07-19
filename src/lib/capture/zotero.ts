import fs from "node:fs";
import path from "node:path";
import { usersRoot } from "../data-dir";
import { getProfile, listProfiles } from "../auth/users";
import { listPapers, type PaperMeta } from "../library/papers";
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

interface ZoteroCreator {
  creatorType?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
}

interface ZoteroItemData {
  key: string;
  version: number;
  itemType: string;
  parentItem?: string;
  contentType?: string;
  title?: string;
  creators?: ZoteroCreator[];
  date?: string;
  publicationTitle?: string;
  url?: string;
  DOI?: string;
  extra?: string;
}

interface ZoteroItem {
  key: string;
  version: number;
  data: ZoteroItemData;
}

interface SyncCursor {
  lastVersion: number;
  /** Zotero item key → library slug, for idempotent re-runs. */
  imported: Record<string, string>;
}

export class ZoteroError extends Error {}

async function zoteroFetch(
  cfg: ZoteroConfig,
  pathname: string,
  search: Record<string, string> = {},
): Promise<Response> {
  const url = new URL(`${API}${pathname}`);
  for (const [k, v] of Object.entries(search)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { "Zotero-API-Key": cfg.apiKey },
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
    headers: { "Zotero-API-Key": apiKey },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { userID?: number; username?: string };
  if (typeof body.userID !== "number") return null;
  return { userId: String(body.userID), username: body.username ?? "" };
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
    version = Number(res.headers.get("Last-Modified-Version") ?? version);
    const page = (await res.json()) as ZoteroItem[];
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
      parent = ((await res.json()) as ZoteroItem).data;
    }
    items.push({ item: parent, attachmentKey: data.key });
  }
  return { items, version };
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
    return JSON.parse(
      fs.readFileSync(cursorPath(username), "utf8"),
    ) as SyncCursor;
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

function overridesOf(item: ZoteroItemData): Partial<PaperMeta> {
  const overrides: Partial<PaperMeta> = {};
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

export function isSyncing(username: string): boolean {
  return inFlight.has(username);
}

/**
 * Pull new PDF items for one profile. Returns null when the profile has no
 * Zotero config or a sync is already running; otherwise counts.
 */
export async function syncProfile(
  username: string,
): Promise<{ imported: number; skipped: number } | null> {
  const profile = getProfile(username); // validates username before path use
  const cfg = profile?.zotero;
  if (!profile || !cfg) return null;
  if (inFlight.has(username)) return null;
  inFlight.add(username);
  try {
    const cursor = readCursor(username);
    const { items, version } = await listNewPdfItems(cfg, cursor.lastVersion);
    const knownArxiv = new Set(
      listPapers()
        .map((p) => p.meta.arxivId)
        .filter(Boolean),
    );
    let imported = 0;
    let skipped = 0;
    for (const { item, attachmentKey } of items) {
      if (cursor.imported[item.key]) {
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
          source: { provider: "zotero", key: item.key, version: item.version },
          overrides: overridesOf(item),
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
      }
    }
    cursor.lastVersion = version;
    writeCursor(username, cursor);
    if (imported > 0) rebuildIndex();
    return { imported, skipped };
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
