import {
  getProfile,
  setZoteroConfig,
  type Profile,
  type ZoteroProfileConfig,
} from "../auth/users";
import {
  beginProfileActivity,
  type ProfileActivity,
} from "../auth/profile-activity";
import { listPapers, type Paper } from "../library/papers";
import { rebuildIndex } from "../library/index-db";
import { capturePdf, removeOwnedCapture } from "./index";
import {
  associationFor,
  associate,
  attachmentsFor,
  citationAuthors,
  collectionMap,
  downloadAttachment,
  existingPaperFor,
  optional,
  overridesOf,
  sourceOf,
  sourceTags,
  storedAttachmentKeys,
  targetOf,
  visibleParentRecords,
  arxivIdOf,
  ZoteroError,
  ZoteroPdfTooLargeError,
} from "./zotero";
import {
  deleteZoteroCatalog,
  libraryIdentity,
  readZoteroCatalog,
  writeZoteroCatalog,
  type ZoteroAssociation,
  type ZoteroCatalogLibrary,
} from "./zotero-catalog";
import { itemLockKey, profileLockKey, withZoteroLock } from "./zotero-lock";

const IMPORT_LOCK_WAIT_MS = 60_000;
const MAX_ANNOTATION_CHARS = 20_000;
const MAX_ANNOTATION_RECORDS = 10_000;

export interface ZoteroCatalogEntry {
  key: string;
  title: string;
  authors: string[];
  year: number | null;
  annotationCount: number;
  hasStoredPdf: boolean;
  imported: { topic: string; slug: string } | null;
}

export interface ZoteroCatalogPage {
  items: ZoteroCatalogEntry[];
  total: number;
  importable: number;
  imported: number;
  page: number;
  limit: number;
  refreshedAt: string | null;
}

function paperForAssociation(
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

function annotationCounts(library: ZoteroCatalogLibrary): Map<string, number> {
  const attachmentParents = new Map<string, string>();
  for (const record of Object.values(library.records)) {
    if (
      record.itemType === "attachment" &&
      record.contentType === "application/pdf"
    ) {
      attachmentParents.set(record.key, record.parentItem ?? record.key);
    }
  }
  const counts = new Map<string, number>();
  for (const record of Object.values(library.records)) {
    if (record.itemType !== "annotation" || !record.parentItem) continue;
    const parent = attachmentParents.get(record.parentItem);
    if (parent) counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  return counts;
}

function emptyPage(page: number, limit: number): ZoteroCatalogPage {
  return {
    items: [],
    total: 0,
    importable: 0,
    imported: 0,
    page,
    limit,
    refreshedAt: null,
  };
}

export async function listCatalogItems(
  username: string,
  query: string,
  page: number,
  limit: number,
): Promise<ZoteroCatalogPage> {
  const profile = getProfile(username);
  if (!profile?.zotero) return emptyPage(page, limit);
  const target = targetOf(profile.zotero);
  const catalog = await readZoteroCatalog(username);
  const library = catalog.libraries[libraryIdentity(target)];
  if (!library) return emptyPage(page, limit);
  const counts = annotationCounts(library);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const entries = visibleParentRecords(profile.zotero, library)
    .map((item): ZoteroCatalogEntry => {
      const paper = paperForAssociation(
        associationFor(catalog.associations, target, item.key),
      );
      const yearMatch = item.date?.match(/\b(\d{4})\b/);
      return {
        key: item.key,
        title:
          optional(item.title) ?? optional(item.filename) ?? "Untitled PDF",
        authors: citationAuthors(item).map(
          (author) =>
            author.literal ??
            [author.given, author.family].filter(Boolean).join(" "),
        ),
        year: yearMatch ? Number(yearMatch[1]) : null,
        annotationCount: counts.get(item.key) ?? 0,
        hasStoredPdf: storedAttachmentKeys(library, item).length > 0,
        imported: paper?.topic
          ? { topic: paper.topic, slug: paper.slug }
          : null,
      };
    })
    .filter((item) => {
      if (!normalizedQuery) return true;
      return `${item.title} ${item.authors.join(" ")}`
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    })
    .sort(
      (a, b) => a.title.localeCompare(b.title) || a.key.localeCompare(b.key),
    );
  const offset = (page - 1) * limit;
  return {
    items: entries.slice(offset, offset + limit),
    total: entries.length,
    importable: entries.filter((item) => item.hasStoredPdf).length,
    imported: entries.filter((item) => item.imported).length,
    page,
    limit,
    refreshedAt: library.refreshedAt,
  };
}

export class ZoteroCatalogItemNotFoundError extends ZoteroError {}
export class ZoteroImportUnavailableError extends ZoteroError {}

export interface ZoteroImportResult {
  created: boolean;
  topic: string;
  slug: string;
}

async function importLocked(
  username: string,
  itemKey: string,
  activity: ProfileActivity,
): Promise<ZoteroImportResult> {
  const profile = getProfile(username);
  const cfg = profile?.zotero;
  if (!profile || !cfg) {
    throw new ZoteroCatalogItemNotFoundError("Zotero is not connected.");
  }
  const target = targetOf(cfg);
  const catalog = await readZoteroCatalog(username);
  const library = catalog.libraries[libraryIdentity(target)];
  const item = library
    ? visibleParentRecords(cfg, library).find(
        (candidate) => candidate.key === itemKey,
      )
    : undefined;
  if (!library || !item) {
    throw new ZoteroCatalogItemNotFoundError(
      "That item is not in the active Zotero catalog.",
    );
  }
  const associated = paperForAssociation(
    associationFor(catalog.associations, target, item.key),
  );
  if (associated?.topic) {
    return { created: false, topic: associated.topic, slug: associated.slug };
  }
  const existing = existingPaperFor(username, target, item);
  if (existing?.topic) {
    associate(catalog, target, item.key, existing);
    await writeZoteroCatalog(username, catalog);
    return { created: false, topic: existing.topic, slug: existing.slug };
  }
  const attachmentKeys = storedAttachmentKeys(library, item);
  if (attachmentKeys.length === 0) {
    throw new ZoteroImportUnavailableError(
      "This item has no stored Zotero PDF available to download.",
    );
  }
  let bytes: Buffer | null = null;
  let lastError: unknown = null;
  for (const attachmentKey of attachmentKeys) {
    try {
      bytes = await downloadAttachment(cfg, attachmentKey);
      break;
    } catch (error) {
      if (error instanceof ZoteroPdfTooLargeError) throw error;
      lastError = error;
    }
  }
  if (!bytes) {
    throw new ZoteroImportUnavailableError(
      lastError instanceof Error
        ? lastError.message
        : "Zotero could not provide this PDF.",
    );
  }
  const captured = await capturePdf(
    bytes,
    {
      sourceUrl:
        optional(item.url) ??
        `https://www.zotero.org/${target.type === "user" ? "users" : "groups"}/${target.id}/items/${item.key}`,
      username,
      arxivId: arxivIdOf(item),
      autoFile: true,
      source: sourceOf(item, target, collectionMap(library)),
      overrides: overridesOf(item),
      sourceTags: sourceTags(item),
    },
    activity,
  );
  if (activity.cancelled()) {
    removeOwnedCapture(username, captured.slug, captured.proposedTopic);
    throw new ZoteroCatalogItemNotFoundError(
      "The importing profile was deleted.",
    );
  }
  const paper = listPapers().find(
    (candidate) =>
      candidate.slug === captured.slug &&
      candidate.topic === captured.proposedTopic,
  );
  if (!paper?.topic) {
    throw new ZoteroError("Imported Zotero paper could not be found.");
  }
  associate(catalog, target, item.key, paper);
  await writeZoteroCatalog(username, catalog);
  rebuildIndex();
  return { created: true, topic: paper.topic, slug: paper.slug };
}

export async function importCatalogItem(
  username: string,
  itemKey: string,
): Promise<ZoteroImportResult> {
  const activity = beginProfileActivity(username);
  if (!activity) {
    throw new ZoteroCatalogItemNotFoundError(
      "The importing profile was deleted.",
    );
  }
  try {
    return await withZoteroLock(profileLockKey(username), 0, async () => {
      const profile = getProfile(username);
      const target = profile?.zotero ? targetOf(profile.zotero) : null;
      if (!target) {
        throw new ZoteroCatalogItemNotFoundError("Zotero is not connected.");
      }
      return withZoteroLock(
        itemLockKey(target.type, target.id, itemKey),
        IMPORT_LOCK_WAIT_MS,
        () => importLocked(username, itemKey, activity),
      );
    });
  } finally {
    activity.finish();
  }
}

export interface ZoteroAnnotationContext {
  pageLabel: string | null;
  text: string;
  comment: string;
}

function cleanAnnotation(value: string | undefined): string {
  return (value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 4_000);
}

export async function annotationsForPaper(
  username: string,
  paper: Paper,
): Promise<ZoteroAnnotationContext[]> {
  const profile = getProfile(username);
  const cfg = profile?.zotero;
  if (!cfg || !paper.topic) return [];
  const target = targetOf(cfg);
  const catalog = await readZoteroCatalog(username);
  const association = Object.values(catalog.associations).find(
    (candidate) =>
      candidate.libraryType === target.type &&
      candidate.libraryId === target.id &&
      candidate.topic === paper.topic &&
      candidate.slug === paper.slug,
  );
  const library = catalog.libraries[libraryIdentity(target)];
  if (!association || !library) return [];
  const item = library.records[association.itemKey];
  if (
    !item ||
    !visibleParentRecords(cfg, library).some(
      (candidate) => candidate.key === association.itemKey,
    )
  ) {
    return [];
  }
  const attachmentKeys = new Set(
    attachmentsFor(library, item).map((attachment) => attachment.key),
  );
  const matching = [];
  for (const record of Object.values(library.records)) {
    if (
      record.itemType === "annotation" &&
      record.parentItem &&
      attachmentKeys.has(record.parentItem)
    ) {
      matching.push(record);
      if (matching.length >= MAX_ANNOTATION_RECORDS) break;
    }
  }
  matching.sort(
    (a, b) =>
      (a.annotationSortIndex ?? "").localeCompare(
        b.annotationSortIndex ?? "",
      ) || a.key.localeCompare(b.key),
  );
  const annotations: ZoteroAnnotationContext[] = [];
  let chars = 0;
  for (const record of matching) {
    const annotation = {
      pageLabel: optional(record.annotationPageLabel) ?? null,
      text: cleanAnnotation(record.annotationText),
      comment: cleanAnnotation(record.annotationComment),
    };
    if (!annotation.text && !annotation.comment) continue;
    const nextChars =
      chars +
      annotation.text.length +
      annotation.comment.length +
      (annotation.pageLabel?.length ?? 0);
    if (nextChars > MAX_ANNOTATION_CHARS) break;
    chars = nextChars;
    annotations.push(annotation);
  }
  return annotations;
}

export async function disconnectZotero(username: string): Promise<void> {
  return withZoteroLock(profileLockKey(username), 0, async () => {
    await deleteZoteroCatalog(username);
    setZoteroConfig(username, null);
  });
}

export async function saveZoteroConfig(
  username: string,
  config: ZoteroProfileConfig,
): Promise<Profile> {
  return withZoteroLock(profileLockKey(username), 0, async () =>
    setZoteroConfig(username, config),
  );
}
