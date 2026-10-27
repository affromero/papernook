import { randomUUID } from "node:crypto";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFObject,
} from "pdf-lib";

export class PdfCommentError extends Error {}

export type PdfCommentAction =
  | { action: "create"; page: number; x: number; y: number; text: string }
  | { action: "edit"; id: string; text: string }
  | { action: "delete"; id: string };

function hasSignature(document: PDFDocument): boolean {
  const visited = new Set<PDFObject>();
  function visit(object: PDFObject): boolean {
    if (object instanceof PDFRef) {
      const resolved = document.context.lookup(object);
      if (!resolved) return false;
      object = resolved;
    }
    if (!object || visited.has(object)) return false;
    visited.add(object);
    if (object instanceof PDFStream) return visit(object.dict);
    if (object instanceof PDFArray) return object.asArray().some(visit);
    if (!(object instanceof PDFDict)) return false;
    if (
      object.has(PDFName.of("ByteRange")) ||
      object.get(PDFName.of("Type")) === PDFName.of("Sig")
    )
      return true;
    return object.entries().some(([, value]) => visit(value));
  }
  return document.context
    .enumerateIndirectObjects()
    .some(([, object]) => visit(object));
}

export async function updatePdfComment(
  bytes: Uint8Array,
  action: PdfCommentAction,
  author: string,
  username: string,
): Promise<Uint8Array> {
  let document: PDFDocument;
  try {
    document = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch {
    throw new PdfCommentError("Cannot edit an encrypted or invalid PDF.");
  }
  if (hasSignature(document))
    throw new PdfCommentError("Cannot rewrite a signed PDF.");
  if (action.action === "create") {
    const page = document.getPages()[action.page - 1];
    if (!page) throw new PdfCommentError("Invalid page.");
    const box = page.getCropBox();
    if (
      action.x < box.x ||
      action.x > box.x + box.width ||
      action.y < box.y ||
      action.y > box.y + box.height
    ) {
      throw new PdfCommentError("Comment position is outside the page.");
    }
    const annotation = document.context.obj({
      Type: "Annot",
      Subtype: "Text",
      Name: "Comment",
      F: 4,
      Rect: [action.x, action.y, action.x + 20, action.y + 20],
      Contents: PDFHexString.fromText(action.text),
      T: PDFHexString.fromText(author),
      PapernookAuthor: PDFString.of(username),
      NM: PDFString.of(`papernook-${randomUUID()}`),
    });
    const ref = document.context.register(annotation);
    page.node.addAnnot(ref);
  } else {
    let found = false;
    for (const page of document.getPages()) {
      const annotations = page.node.Annots();
      if (!(annotations instanceof PDFArray)) continue;
      for (let index = 0; index < annotations.size(); index++) {
        const ref = annotations.get(index);
        if (!(ref instanceof PDFRef)) continue;
        const refId = `${ref.objectNumber}R${ref.generationNumber || ""}`;
        if (refId !== action.id) continue;
        const annotation = annotations.lookup(index);
        if (!(annotation instanceof PDFDict)) continue;
        if (annotation.get(PDFName.of("Subtype")) !== PDFName.of("Text"))
          continue;
        const name = annotation.lookupMaybe(
          PDFName.of("NM"),
          PDFString,
          PDFHexString,
        );
        if (!name || !name.decodeText().startsWith("papernook-")) continue;
        const owner = annotation.lookupMaybe(
          PDFName.of("PapernookAuthor"),
          PDFString,
        );
        if (!owner || owner.decodeText() !== username)
          throw new PdfCommentError("Only the author can edit this comment.");
        if (action.action === "delete") annotations.remove(index);
        else
          annotation.set(
            PDFName.of("Contents"),
            PDFHexString.fromText(action.text),
          );
        found = true;
        break;
      }
      if (found) break;
    }
    if (!found) throw new PdfCommentError("Comment was not found.");
  }
  return document.save();
}
