import {
  createTLSchema,
  type TLRecord,
  type TLStoreSnapshot,
} from "@tldraw/tlschema";
import { z } from "zod";
import { CanvasError } from "./errors";
import { canvasMediaType, portableAssetNameSchema } from "./media";

export type CanvasDocument = TLStoreSnapshot;
const MAX_SHARED_CANVAS_BYTES = 4 * 1024 * 1024;
const schema = createTLSchema();
const snapshotSchema = z
  .object({
    store: z.record(z.string().max(160), z.unknown()),
    schema: z
      .object({
        schemaVersion: z.literal(2),
        sequences: z.record(
          z.string().max(160),
          z.number().int().nonnegative(),
        ),
      })
      .strict(),
  })
  .strict();
const recordTypes = ["document", "page", "shape", "asset", "binding"] as const;
const recordTypeSchema = z.enum(recordTypes);
const label = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[^\p{C}]+$/u);
const metaSchema = z
  .object({
    papernookPdfPageNumber: z.number().int().positive().max(1000).optional(),
    papernookPdfPageCount: z.number().int().positive().max(1000).optional(),
    papernookPdfVersion: z.string().max(100).optional(),
    papernookCreatedBy: z.string().min(1).max(100).optional(),
    papernookCreatedByName: label.optional(),
    papernookUpdatedBy: z.string().min(1).max(100).optional(),
    papernookUpdatedByName: label.optional(),
  })
  .strict();
const nodeSchema = z
  .object({
    type: z.enum([
      "doc",
      "paragraph",
      "text",
      "hardBreak",
      "heading",
      "bulletList",
      "orderedList",
      "listItem",
    ]),
    text: z.string().max(100_000).optional(),
    content: z.array(z.unknown()).max(10_000).optional(),
    attrs: z.record(z.string(), z.unknown()).optional(),
    marks: z
      .array(
        z
          .object({
            type: z.enum([
              "bold",
              "italic",
              "strike",
              "underline",
              "code",
              "highlight",
              "link",
            ]),
            attrs: z.record(z.string(), z.unknown()).optional(),
          })
          .strict(),
      )
      .max(10)
      .optional(),
  })
  .strict();

function reject(
  message = "This canvas contains unsupported or unsafe content.",
): never {
  throw new CanvasError(message, 422);
}

/** Bound traversal before migrations or recursive rich-text validation run. */
function boundedJson(value: unknown): void {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const next = pending.pop()!;
    if (++nodes > 100_000 || next.depth > 32)
      reject("The canvas is too complex to share.");
    if (
      next.value === null ||
      typeof next.value === "boolean" ||
      typeof next.value === "string"
    )
      continue;
    if (typeof next.value === "number") {
      if (!Number.isFinite(next.value)) reject();
      continue;
    }
    if (typeof next.value !== "object") reject();
    if (
      !Array.isArray(next.value) &&
      ![Object.prototype, null].includes(Object.getPrototypeOf(next.value))
    )
      reject();
    for (const [key, child] of Object.entries(next.value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) reject();
      pending.push({ value: child, depth: next.depth + 1 });
    }
  }
}

function clickableUrl(value: string): void {
  if (!value) return;
  if (value.length > 4000 || /[\p{C}]/u.test(value))
    reject("A canvas link is unsafe.");
  try {
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      reject("Shared canvas links must use HTTP or HTTPS.");
  } catch {
    reject("A canvas link is unsafe.");
  }
}

function richText(value: unknown, depth = 0): unknown {
  if (depth > 16) reject("Canvas text is too deeply nested.");
  const parsed = nodeSchema.safeParse(value);
  if (!parsed.success) reject();
  const node = parsed.data;
  const attrs = z
    .object({
      dir: z.enum(["auto", "ltr", "rtl"]).nullable().optional(),
      textAlign: z
        .enum(["start", "end", "left", "right", "center", "justify"])
        .nullable()
        .optional(),
      level: z.number().int().min(1).max(6).optional(),
      start: z.number().int().min(1).max(1_000_000).optional(),
      type: z.string().max(1).nullable().optional(),
    })
    .strict()
    .safeParse(node.attrs ?? {});
  if (
    !attrs.success ||
    (node.type !== "heading" && attrs.data.level !== undefined) ||
    (node.type !== "orderedList" && attrs.data.start !== undefined)
  )
    reject();
  if (node.type === "text" && (!node.text || node.content)) reject();
  if (node.type !== "text" && node.text !== undefined) reject();
  const marks = node.marks?.map((mark) => {
    if (mark.type === "link") {
      const link = z
        .object({
          href: z.string().min(1).max(4000),
          target: z.literal("_blank").nullable().optional(),
          rel: z.string().max(100).nullable().optional(),
          class: z.null().optional(),
        })
        .strict()
        .safeParse(mark.attrs);
      if (!link.success) reject();
      clickableUrl(link.data.href);
      return {
        type: mark.type,
        attrs: {
          href: link.data.href,
          target: "_blank",
          rel: "noopener noreferrer",
          class: null,
        },
      };
    }
    if (mark.type === "highlight") {
      if (
        !z
          .object({
            color: z
              .string()
              .regex(/^#[a-f0-9]{3,8}$/i)
              .nullable()
              .optional(),
          })
          .strict()
          .safeParse(mark.attrs ?? {}).success
      )
        reject();
    } else if (Object.keys(mark.attrs ?? {}).length) reject();
    return mark;
  });
  return {
    ...node,
    ...(node.content
      ? { content: node.content.map((child) => richText(child, depth + 1)) }
      : {}),
    ...(marks ? { marks } : {}),
  };
}

/** Canonical tldraw validation plus the narrower, portable sharing policy. */
export function validateSharedCanvas(
  value: unknown,
  resolveAsset: (source: string) => string,
): CanvasDocument | null {
  if (value === null) return null;
  boundedJson(value);
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_SHARED_CANVAS_BYTES)
    reject("The canvas exceeds the 4 MB sharing limit.");
  const parsed = snapshotSchema.safeParse(value);
  if (
    !parsed.success ||
    Object.keys(parsed.data.store).length > 10_000 ||
    Object.keys(parsed.data.schema.sequences).length > 100
  )
    reject();
  try {
    const migrated = schema.migrateStoreSnapshot({
      store: parsed.data.store as TLStoreSnapshot["store"],
      schema: parsed.data.schema,
    });
    if (migrated.type !== "success")
      reject(
        "Open and save this canvas with the current Papernook before sharing it.",
      );
    const store: CanvasDocument["store"] = {};
    for (const [key, raw] of Object.entries(migrated.value)) {
      const type = recordTypeSchema.safeParse(raw.typeName);
      if (
        !type.success ||
        key !== raw.id ||
        !new RegExp(`^${type.data}:[a-zA-Z0-9_-]{1,140}$`).test(key)
      )
        reject(
          "Only document records can be shared. Session and user records are excluded.",
        );
      const record = schema.types[type.data].validate(raw) as TLRecord;
      const meta = metaSchema.safeParse(record.meta);
      if (!meta.success) reject("The canvas contains unsupported metadata.");
      if (record.typeName === "shape") {
        if (["embed", "bookmark"].includes(record.type))
          reject(
            "Shared canvases cannot load remote embeds or bookmarks. Use links or uploaded media.",
          );
        if (
          !Number.isFinite(record.x) ||
          !Number.isFinite(record.y) ||
          Math.abs(record.x) > 1_000_000 ||
          Math.abs(record.y) > 1_000_000 ||
          Math.abs(record.rotation) > 1000
        )
          reject();
        if ("url" in record.props && typeof record.props.url === "string")
          clickableUrl(record.props.url);
        if ("richText" in record.props) richText(record.props.richText);
      }
      store[record.id] = structuredClone(record);
    }
    const documents = Object.values(store).filter(
      (record) => record.typeName === "document",
    );
    const pages = Object.values(store).filter(
      (record) => record.typeName === "page",
    );
    if (documents.length !== 1 || pages.length < 1 || pages.length > 100)
      reject();
    const referencedAssets = new Set<string>();
    const terminals = new Set<string>();
    const pageFor = (id: string): string | null => {
      let record = Object.values(store).find((record) => record.id === id);
      const visited = new Set<string>();
      while (record?.typeName === "shape") {
        if (visited.has(record.id) || visited.size > 100) reject();
        visited.add(record.id);
        record = store[record.parentId];
      }
      return record?.typeName === "page" ? record.id : null;
    };
    for (const record of Object.values(store)) {
      if (record.typeName === "shape") {
        const visited = new Set([record.id]);
        let parent = store[record.parentId];
        while (parent?.typeName === "shape") {
          if (
            visited.has(parent.id) ||
            visited.size > 100 ||
            !["group", "frame"].includes(parent.type)
          )
            reject("Canvas parent relationships are invalid.");
          visited.add(parent.id);
          parent = store[parent.parentId];
        }
        if (parent?.typeName !== "page") reject("A canvas shape has no page.");
        if ("assetId" in record.props && record.props.assetId) {
          const asset = store[record.props.assetId];
          if (asset?.typeName !== "asset" || asset.type === "bookmark")
            reject("A canvas image or video is missing.");
          referencedAssets.add(asset.id);
        }
      }
      if (
        record.typeName === "binding" &&
        (store[record.fromId]?.typeName !== "shape" ||
          store[record.toId]?.typeName !== "shape")
      )
        reject("A canvas binding points outside this document.");
      if (record.typeName === "binding") {
        const from = store[record.fromId];
        const to = store[record.toId];
        const terminal = `${record.fromId}:${record.props.terminal}`;
        if (
          from?.typeName !== "shape" ||
          from.type !== "arrow" ||
          to?.typeName !== "shape" ||
          to.type === "arrow" ||
          record.fromId === record.toId ||
          pageFor(record.fromId) !== pageFor(record.toId) ||
          terminals.has(terminal)
        )
          reject("Canvas arrow bindings are invalid.");
        terminals.add(terminal);
      }
    }
    for (const record of Object.values(store)) {
      if (record.typeName === "asset") {
        if (!referencedAssets.has(record.id)) {
          delete store[record.id];
          continue;
        }
        if (
          record.type === "bookmark" ||
          !record.props.src ||
          record.props.w <= 0 ||
          record.props.h <= 0 ||
          record.props.w > 32_768 ||
          record.props.h > 32_768
        )
          reject("A canvas media asset is invalid.");
        record.props.src = resolveAsset(record.props.src);
        if (
          !record.props.src.startsWith("/canvas-assets/") ||
          !portableAssetNameSchema.safeParse(record.props.src.slice(15)).success
        )
          reject("Canvas assets must use portable content addresses.");
        const mime = canvasMediaType(record.props.src.split("/").at(-1)!);
        if (!mime.startsWith(`${record.type}/`))
          reject("Canvas media type does not match its record.");
        record.props.mimeType = mime;
      }
      if (record.typeName === "shape" && "richText" in record.props)
        record.props.richText = richText(
          record.props.richText,
        ) as typeof record.props.richText;
    }
    return { store, schema: schema.serialize() };
  } catch (error) {
    if (error instanceof CanvasError) throw error;
    reject("The canvas document is invalid or uses an unsupported schema.");
  }
}

/** Attribution comes from the authenticated server, never submitted metadata. */
export function attributeCanvas(
  next: CanvasDocument,
  previous: CanvasDocument | null,
  actor: { id: string; name: string },
): CanvasDocument {
  const store = structuredClone(next.store);
  const withoutAttribution = (record: TLRecord) => {
    const meta = { ...record.meta };
    for (const name of [
      "papernookCreatedBy",
      "papernookCreatedByName",
      "papernookUpdatedBy",
      "papernookUpdatedByName",
    ])
      delete meta[name];
    return { ...record, meta };
  };
  for (const record of Object.values(store)) {
    const before = previous?.store[record.id];
    if (
      before &&
      JSON.stringify(withoutAttribution(before)) ===
        JSON.stringify(withoutAttribution(record))
    ) {
      record.meta = before.meta;
      continue;
    }
    record.meta = {
      ...record.meta,
      papernookCreatedBy: before?.meta.papernookCreatedBy ?? actor.id,
      papernookCreatedByName: before?.meta.papernookCreatedByName ?? actor.name,
      papernookUpdatedBy: actor.id,
      papernookUpdatedByName: actor.name,
    };
  }
  return { ...next, store };
}
