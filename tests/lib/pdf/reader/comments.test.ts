import { describe, expect, it } from "vitest";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRef,
} from "pdf-lib";
import { updatePdfComment } from "@/lib/library/pdf/comments";

describe("PDF comments", () => {
  it("creates, edits and deletes an attributed note while preserving other annotations", async () => {
    const original = await PDFDocument.create();
    original.setTitle("Research paper");
    const page = original.addPage([500, 700]);
    const existing = original.context.obj({
      Type: "Annot",
      Subtype: "Text",
      Rect: [10, 10, 30, 30],
      Contents: PDFHexString.fromText("Existing note"),
    });
    page.node.addAnnot(original.context.register(existing));
    const created = await updatePdfComment(
      await original.save(),
      { action: "create", page: 1, x: 100, y: 200, text: "Δ evidence" },
      "Maya Chen",
      "maya",
    );
    const doc = await PDFDocument.load(created);
    const annots = doc.getPage(0).node.Annots() as PDFArray;
    expect(annots.size()).toBe(2);
    const ref = annots.get(1) as PDFRef;
    const id = `${ref.objectNumber}R${ref.generationNumber || ""}`;
    const note = annots.lookup(1, PDFDict);
    expect(note.lookup(PDFName.of("T"), PDFHexString).decodeText()).toBe(
      "Maya Chen",
    );
    expect(note.lookup(PDFName.of("Contents"), PDFHexString).decodeText()).toBe(
      "Δ evidence",
    );
    expect(doc.getTitle()).toBe("Research paper");
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loading = pdfjs.getDocument({ data: created.slice() });
    const reader = await loading.promise;
    const annotations = await (await reader.getPage(1)).getAnnotations();
    expect(annotations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subtype: "Text",
          titleObj: expect.objectContaining({ str: "Maya Chen" }),
          contentsObj: expect.objectContaining({ str: "Δ evidence" }),
        }),
      ]),
    );
    await loading.destroy();
    await expect(
      updatePdfComment(
        created,
        { action: "edit", id, text: "Changed" },
        "Someone Else",
        "other",
      ),
    ).rejects.toThrow("Only the author");
    const edited = await updatePdfComment(
      created,
      { action: "edit", id, text: "Changed" },
      "Maya Chen",
      "maya",
    );
    const afterEdit = await PDFDocument.load(edited);
    const changed = afterEdit.getPage(0).node.Annots()?.lookup(1, PDFDict);
    expect(
      changed?.lookup(PDFName.of("Contents"), PDFHexString).decodeText(),
    ).toBe("Changed");
    expect(changed?.lookup(PDFName.of("T"), PDFHexString).decodeText()).toBe(
      "Maya Chen",
    );
    const deleted = await updatePdfComment(
      edited,
      { action: "delete", id },
      "Maya Chen",
      "maya",
    );
    const afterDelete = await PDFDocument.load(deleted);
    const remaining = afterDelete.getPage(0).node.Annots();
    expect(remaining?.size()).toBe(1);
    expect(
      remaining
        ?.lookup(0, PDFDict)
        .lookup(PDFName.of("Contents"), PDFHexString)
        .decodeText(),
    ).toBe("Existing note");
  });

  it("rejects signed PDFs", async () => {
    const document = await PDFDocument.create();
    document.addPage();
    document.catalog.set(
      PDFName.of("TestSignature"),
      document.context.obj({ Type: "Sig", ByteRange: [0, 1, 2, 3] }),
    );
    await expect(
      updatePdfComment(
        await document.save(),
        { action: "create", page: 1, x: 1, y: 1, text: "Note" },
        "Maya",
        "maya",
      ),
    ).rejects.toThrow("signed PDF");
  });
});
