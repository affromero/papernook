import { randomUUID } from "node:crypto";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
} from "pdf-lib";
import { z } from "zod";
import { SharingError, labelSchema } from "./protocol/values";

const point = z.number().finite().min(-100_000).max(100_000);
const annotationSchema = z.object({
  type: z.enum([
    "Text",
    "FreeText",
    "Highlight",
    "Underline",
    "StrikeOut",
    "Squiggly",
    "Ink",
  ]),
  rect: z.tuple([point, point, point, point]),
  text: z.string().max(10_000),
  color: z.array(z.number().finite().min(0).max(1)).length(3),
  opacity: z.number().finite().min(0).max(1),
  width: z.number().finite().min(0.1).max(30),
  size: z.number().finite().min(1).max(200),
  quads: z.array(point).max(16_000),
  ink: z.array(z.array(point).min(4).max(20_000)).max(200),
});
type Annotation = z.infer<typeof annotationSchema>;
interface Entry {
  key: string;
  page: number;
  dict: PDFDict;
  ref: PDFRef;
}

function textValue(dict: PDFDict, key: string): string {
  return (
    dict.lookupMaybe(PDFName.of(key), PDFString, PDFHexString)?.decodeText() ??
    ""
  );
}
function numbers(dict: PDFDict, key: string): number[] {
  const values = dict.lookupMaybe(PDFName.of(key), PDFArray);
  return values
    ? values.asArray().map((v) => {
        if (!(v instanceof PDFNumber))
          throw new SharingError("Invalid annotation coordinates.");
        return v.asNumber();
      })
    : [];
}
function number(dict: PDFDict, key: string, fallback: number): number {
  return dict.lookupMaybe(PDFName.of(key), PDFNumber)?.asNumber() ?? fallback;
}
function entries(document: PDFDocument): Entry[] {
  const result: Entry[] = [];
  const used = new Set<string>();
  for (const [page, value] of document.getPages().entries()) {
    const annotations = value.node.Annots();
    for (let i = 0; annotations && i < annotations.size(); i++) {
      const ref = annotations.get(i);
      if (!(ref instanceof PDFRef))
        throw new SharingError("Annotations must have stable references.");
      const dict = annotations.lookup(i, PDFDict);
      const name = textValue(dict, "NM");
      const key = name ? `name:${name}` : `ref:${ref.toString()}`;
      if (used.has(key))
        throw new SharingError("Duplicate annotation identity.");
      used.add(key);
      result.push({ key, page, dict, ref });
      if (result.length > 5000)
        throw new SharingError("Too many annotations.", 413);
    }
  }
  return result;
}

function annotationValue(dict: PDFDict): Annotation {
  const type = dict.lookupMaybe(PDFName.of("Subtype"), PDFName)?.decodeText();
  const color = numbers(dict, "C");
  const border = dict.lookupMaybe(PDFName.of("BS"), PDFDict);
  const strokes = dict.lookupMaybe(PDFName.of("InkList"), PDFArray);
  const ink =
    strokes?.asArray().map((stroke) => {
      if (!(stroke instanceof PDFArray))
        throw new SharingError("Invalid ink stroke.");
      return stroke.asArray().map((v) => {
        if (!(v instanceof PDFNumber))
          throw new SharingError("Invalid ink point.");
        return v.asNumber();
      });
    }) ?? [];
  const da = textValue(dict, "DA");
  const rgb = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da);
  const gray = /([\d.]+)\s+g(?:\s|$)/.exec(da);
  const textColor = rgb
    ? rgb.slice(1).map(Number)
    : gray
      ? [Number(gray[1]), Number(gray[1]), Number(gray[1])]
      : null;
  const size = /([\d.]+)\s+Tf/.exec(da)?.[1];
  const value = annotationSchema.safeParse({
    type,
    rect: numbers(dict, "Rect"),
    text: textValue(dict, "Contents"),
    color:
      type === "FreeText" && textColor
        ? textColor
        : color.length === 0
          ? type === "Text" || type === "Highlight"
            ? [1, 0.85, 0]
            : [0, 0, 0]
          : color.length === 1
            ? [color[0], color[0], color[0]]
            : color,
    opacity: number(dict, "CA", 1),
    width: border ? number(border, "W", 1) : 1,
    size: size ? Number(size) : 12,
    quads: numbers(dict, "QuadPoints"),
    ink,
  });
  if (!value.success)
    throw new SharingError(
      "This annotation type or geometry cannot be shared safely.",
      422,
    );
  if (
    value.data.quads.length % 8 ||
    value.data.ink.some((stroke) => stroke.length % 2)
  )
    throw new SharingError("Invalid annotation geometry.", 422);
  return value.data;
}

/** Compare only inert annotation data. Remote dictionaries and streams never cross this boundary. */
function signature(entry: Entry): string {
  const dict = entry.dict;
  return JSON.stringify({
    page: entry.page,
    type: dict.get(PDFName.of("Subtype"))?.toString(),
    rect: numbers(dict, "Rect"),
    contents: textValue(dict, "Contents"),
    color: numbers(dict, "C"),
    opacity: number(dict, "CA", 1),
    quads: numbers(dict, "QuadPoints"),
    ink: dict.get(PDFName.of("InkList"))?.toString(),
    da: textValue(dict, "DA"),
    border: dict.get(PDFName.of("BS"))?.toString(),
  });
}

function assertBounds(
  annotation: Annotation,
  document: PDFDocument,
  pageIndex: number,
): void {
  const box = document.getPage(pageIndex).getCropBox();
  const inside = (x: number, y: number) =>
    x >= box.x - 1 &&
    y >= box.y - 1 &&
    x <= box.x + box.width + 1 &&
    y <= box.y + box.height + 1;
  const [x1, y1, x2, y2] = annotation.rect;
  if (x2 <= x1 || y2 <= y1 || !inside(x1, y1) || !inside(x2, y2))
    throw new SharingError("Annotation is outside the page.", 422);
  const coordinates = [...annotation.quads, ...annotation.ink.flat()];
  for (let i = 0; i < coordinates.length; i += 2)
    if (!inside(coordinates[i], coordinates[i + 1]))
      throw new SharingError("Annotation points are outside the page.", 422);
  if (
    (annotation.type === "Ink" && annotation.ink.length === 0) ||
    (["Highlight", "Underline", "StrikeOut", "Squiggly"].includes(
      annotation.type,
    ) &&
      annotation.quads.length === 0)
  )
    throw new SharingError("Annotation geometry is missing.", 422);
}

/** Apply a proposed editor save as primitive operations on the trusted original PDF. */
export async function applyCollaborativeAnnotations(
  current: Uint8Array,
  proposed: Uint8Array,
  actor: { id: string; name: string },
  owner = false,
): Promise<Uint8Array> {
  labelSchema.parse(actor.name);
  let trusted: PDFDocument;
  let remote: PDFDocument;
  try {
    trusted = await PDFDocument.load(current, {
      updateMetadata: false,
      throwOnInvalidObject: true,
    });
    remote = await PDFDocument.load(proposed, {
      updateMetadata: false,
      throwOnInvalidObject: true,
    });
  } catch {
    throw new SharingError("Cannot share an encrypted or invalid PDF.", 422);
  }
  if (remote.context.enumerateIndirectObjects().length > 100_000)
    throw new SharingError("The PDF is too complex.", 413);
  if (trusted.getPageCount() !== remote.getPageCount())
    throw new SharingError("Collaboration can change annotations only.", 422);
  for (let i = 0; i < trusted.getPageCount(); i++) {
    if (
      JSON.stringify(trusted.getPage(i).getCropBox()) !==
        JSON.stringify(remote.getPage(i).getCropBox()) ||
      trusted.getPage(i).getRotation().angle !==
        remote.getPage(i).getRotation().angle
    )
      throw new SharingError(
        "Collaboration cannot resize or rotate pages.",
        422,
      );
  }
  // Rewriting signed PDFs would invalidate signatures. Never do that silently.
  for (const [, object] of trusted.context.enumerateIndirectObjects())
    if (
      object instanceof PDFDict &&
      (object.has(PDFName.of("ByteRange")) ||
        object.get(PDFName.of("Type")) === PDFName.of("Sig"))
    )
      throw new SharingError(
        "Signed PDFs cannot be collaboratively annotated.",
        422,
      );
  const existing = entries(trusted);
  const next = entries(remote);
  const byKey = new Map(next.map((entry) => [entry.key, entry]));
  const mutations: { before?: Entry; after?: Entry; value?: Annotation }[] = [];
  for (const before of existing) {
    const after = byKey.get(before.key);
    byKey.delete(before.key);
    if (after && signature(before) === signature(after)) continue;
    if (!owner && textValue(before.dict, "PapernookAuthor") !== actor.id)
      throw new SharingError(
        "Only the author can change this annotation.",
        403,
      );
    if (after) {
      const value = annotationValue(after.dict);
      assertBounds(value, trusted, after.page);
      mutations.push({ before, after, value });
    } else mutations.push({ before });
  }
  for (const after of byKey.values()) {
    const value = annotationValue(after.dict);
    assertBounds(value, trusted, after.page);
    mutations.push({ after, value });
  }
  if (mutations.length > 1000)
    throw new SharingError("Too many annotation changes in one save.", 413);
  if (mutations.length === 0) return current;
  for (const mutation of mutations) {
    if (mutation.before)
      trusted
        .getPage(mutation.before.page)
        .node.removeAnnot(mutation.before.ref);
    if (!mutation.after || !mutation.value) continue;
    const value = mutation.value;
    const name = mutation.before
      ? textValue(mutation.before.dict, "NM") || `papernook-${randomUUID()}`
      : `papernook-${randomUUID()}`;
    const annotation = trusted.context.obj({
      Type: "Annot",
      Subtype: value.type,
      Rect: value.rect,
      F: 4,
      NM: PDFString.of(name),
      T: PDFHexString.fromText(actor.name),
      PapernookAuthor: PDFString.of(actor.id),
      Contents: PDFHexString.fromText(value.text),
      C: value.color,
      CA: value.opacity,
      BS: { W: value.width, S: "S" },
      ...(value.type === "Text" ? { Name: "Comment" } : {}),
      ...(value.type === "FreeText"
        ? {
            DA: PDFString.of(
              `/Helv ${value.size} Tf ${value.color.join(" ")} rg`,
            ),
            Q: 0,
          }
        : {}),
      ...(value.quads.length ? { QuadPoints: value.quads } : {}),
      ...(value.ink.length ? { InkList: value.ink } : {}),
    });
    trusted
      .getPage(mutation.after.page)
      .node.addAnnot(trusted.context.register(annotation));
  }
  return trusted.save();
}
