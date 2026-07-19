import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { usersRoot } from "../data-dir";
import type { ZoteroLibraryTarget } from "../auth/users";

const CATALOG_FILE = "zotero-catalog.json";
export const MAX_CATALOG_BYTES = 64 * 1024 * 1024;
export const MAX_CATALOG_RECORDS = 200_000;

const shortString = z.string().max(1_000);
const longString = z.string().max(50_000);
const creatorSchema = z.object({
  creatorType: z.string().max(64).optional(),
  name: shortString.optional(),
  firstName: shortString.optional(),
  lastName: shortString.optional(),
});
const tagSchema = z.object({ tag: z.string().max(500) });

export const catalogRecordSchema = z.object({
  key: z.string().min(1).max(64),
  version: z.number().int().nonnegative(),
  itemType: z.string().min(1).max(64),
  parentItem: z.string().min(1).max(64).optional(),
  contentType: z.string().max(256).optional(),
  linkMode: z.string().max(64).optional(),
  filename: shortString.optional(),
  title: longString.optional(),
  creators: z.array(creatorSchema).max(500).optional(),
  date: z.string().max(256).optional(),
  publicationTitle: longString.optional(),
  conferenceName: longString.optional(),
  university: longString.optional(),
  institution: longString.optional(),
  url: longString.optional(),
  DOI: shortString.optional(),
  extra: longString.optional(),
  volume: z.string().max(256).optional(),
  issue: z.string().max(256).optional(),
  pages: z.string().max(256).optional(),
  publisher: longString.optional(),
  place: longString.optional(),
  abstractNote: longString.optional(),
  language: z.string().max(256).optional(),
  ISBN: z.string().max(256).optional(),
  ISSN: z.string().max(256).optional(),
  tags: z.array(tagSchema).max(1_000).optional(),
  collections: z.array(z.string().min(1).max(64)).max(1_000).optional(),
  annotationType: z.string().max(64).optional(),
  annotationText: longString.optional(),
  annotationComment: longString.optional(),
  annotationColor: z.string().max(64).optional(),
  annotationPageLabel: z.string().max(256).optional(),
  annotationSortIndex: z.string().max(256).optional(),
});

export type ZoteroCatalogRecord = z.infer<typeof catalogRecordSchema>;

const collectionSchema = z.object({
  key: z.string().min(1).max(64),
  name: z.string().min(1).max(1_000),
  parentCollection: z.string().min(1).max(64).nullable(),
});

const librarySchema = z.object({
  target: z.object({
    type: z.enum(["user", "group"]),
    id: z.string().regex(/^\d+$/),
    name: z.string().min(1).max(1_000),
  }),
  lastVersion: z.number().int().nonnegative(),
  refreshedAt: z.string().datetime().nullable(),
  collections: z.array(collectionSchema).max(100_000),
  records: z.record(z.string().min(1).max(64), catalogRecordSchema),
});

export type ZoteroCatalogLibrary = z.infer<typeof librarySchema>;

const associationSchema = z.object({
  libraryType: z.enum(["user", "group"]),
  libraryId: z.string().regex(/^\d+$/),
  itemKey: z.string().min(1).max(64),
  topic: z.string().min(1).max(80),
  slug: z.string().min(1).max(80),
});

export type ZoteroAssociation = z.infer<typeof associationSchema>;

const catalogSchema = z.object({
  formatVersion: z.literal(1),
  libraries: z.record(z.string().max(96), librarySchema),
  associations: z.record(z.string().max(160), associationSchema),
});

export type ZoteroCatalog = z.infer<typeof catalogSchema>;

function emptyCatalog(): ZoteroCatalog {
  return { formatVersion: 1, libraries: {}, associations: {} };
}

function catalogPath(username: string): string {
  return path.join(usersRoot(), username, CATALOG_FILE);
}

export function libraryIdentity(target: ZoteroLibraryTarget): string {
  return `${target.type}:${target.id}`;
}

export function associationIdentity(
  target: ZoteroLibraryTarget,
  itemKey: string,
): string {
  return `${libraryIdentity(target)}:${itemKey}`;
}

function withinLimits(catalog: ZoteroCatalog): boolean {
  return Object.values(catalog.libraries).every(
    (library) => Object.keys(library.records).length <= MAX_CATALOG_RECORDS,
  );
}

function assertByteBudget(catalog: ZoteroCatalog): void {
  let bytes = 256;
  const add = (value: unknown): void => {
    bytes += Buffer.byteLength(JSON.stringify(value), "utf8") + 16;
    if (bytes > MAX_CATALOG_BYTES) {
      throw new Error("Zotero catalog exceeds the 64 MB metadata limit.");
    }
  };
  for (const [identity, library] of Object.entries(catalog.libraries)) {
    add(identity);
    add(library.target);
    add(library.lastVersion);
    add(library.refreshedAt);
    for (const collection of library.collections) add(collection);
    for (const [key, record] of Object.entries(library.records)) {
      add(key);
      add(record);
    }
  }
  for (const [identity, association] of Object.entries(catalog.associations)) {
    add(identity);
    add(association);
  }
}

export async function readZoteroCatalog(
  username: string,
): Promise<ZoteroCatalog> {
  try {
    const file = catalogPath(username);
    const stat = await fs.stat(file);
    if (stat.size > MAX_CATALOG_BYTES) return emptyCatalog();
    const raw = await fs.readFile(file, "utf8");
    const parsed = catalogSchema.safeParse(JSON.parse(raw));
    return parsed.success && withinLimits(parsed.data)
      ? parsed.data
      : emptyCatalog();
  } catch {
    return emptyCatalog();
  }
}

export async function writeZoteroCatalog(
  username: string,
  catalog: ZoteroCatalog,
): Promise<void> {
  if (!withinLimits(catalog)) {
    throw new Error("Zotero catalog contains too many records.");
  }
  assertByteBudget(catalog);
  const serialized = JSON.stringify(catalog);
  if (Buffer.byteLength(serialized, "utf8") > MAX_CATALOG_BYTES) {
    throw new Error("Zotero catalog exceeds the 64 MB metadata limit.");
  }
  const file = catalogPath(username);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, serialized, { mode: 0o600 });
  await fs.rename(tmp, file);
}

export async function deleteZoteroCatalog(username: string): Promise<void> {
  await fs.rm(catalogPath(username), { force: true });
}

export function emptyLibrary(
  target: ZoteroLibraryTarget,
): ZoteroCatalogLibrary {
  return {
    target,
    lastVersion: 0,
    refreshedAt: null,
    collections: [],
    records: {},
  };
}
