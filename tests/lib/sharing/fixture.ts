import fs from "node:fs";
import path from "node:path";
import {
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFString,
  PDFDict,
} from "pdf-lib";
import { createTestProfile, testProfileCapability } from "../../helpers/access";

export async function fixture(
  mode: "view" | "fork" | "collaborate" = "collaborate",
) {
  await createTestProfile("Ana");
  const papers = await import("@/lib/library/papers");
  const shares = await import("@/lib/library/shares");
  const storage = await import("@/lib/sharing/storage");
  papers.writeMeta("nlp", "attention", {
    title: "Attention Is All You Need",
    authors: ["Vaswani"],
    year: 2017,
    venue: "NeurIPS",
    arxivId: "1706.03762",
    bibtex: null,
    tags: ["transformers"],
    related: [],
    sourceUrl: "https://arxiv.org/abs/1706.03762",
    addedAt: new Date().toISOString(),
    addedBy: "ana",
    source: { provider: "zotero", key: "SECRET_SOURCE", version: 9 },
  });
  papers.writeSummary("nlp", "attention", "A shared summary.");
  papers.writeText("nlp", "attention", "The transformer paper.");
  const document = await PDFDocument.create();
  const page = document.addPage([600, 800]);
  page.drawText("Trusted paper content", { x: 50, y: 700 });
  page.node.addAnnot(
    document.context.register(
      document.context.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: [10, 10, 80, 30],
        A: {
          Type: "Action",
          S: "URI",
          URI: PDFString.of("https://example.org"),
        },
      }),
    ),
  );
  const pdf = papers.pdfPath("nlp", "attention");
  fs.mkdirSync(path.dirname(pdf), { recursive: true });
  fs.writeFileSync(pdf, await document.save());
  const old = new Date(Date.now() - 10_000);
  fs.utimesSync(pdf, old, old);
  const capability = testProfileCapability("ana");
  const share = shares.createShare("nlp", "attention", capability, [], mode);
  const token = storage.newSecret();
  const participant = await storage.withCollaboration(share, async () =>
    storage.requestParticipant(share, token, "Maya"),
  );
  if (mode === "collaborate")
    await storage.withCollaboration(share, async () =>
      storage.setParticipant(
        share,
        participant.id,
        "approved",
        "Maya Approved",
      ),
    );
  return {
    papers,
    shares,
    storage,
    share,
    token,
    participant,
    capability,
    pdf,
  };
}

export async function post(
  shareId: string,
  token: string | null,
  action: string,
  body: Record<string, unknown> = {},
) {
  const { POST } =
    await import("@/app/api/v1/shares/[topic]/[slug]/[shareId]/exchange/route");
  return POST(
    new Request(
      "https://papers.example/api/v1/shares/nlp/attention/" +
        shareId +
        "/exchange",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sharing-Operation": action,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ action, ...body }),
      },
    ),
    { params: Promise.resolve({ topic: "nlp", slug: "attention", shareId }) },
  );
}

export async function annotated(
  bytes: Uint8Array,
  options: {
    type?: string;
    text?: string;
    name?: string;
    author?: string;
    x?: number;
  } = {},
) {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const x = options.x ?? 100;
  document.getPage(0).node.addAnnot(
    document.context.register(
      document.context.obj({
        Type: "Annot",
        Subtype: options.type ?? "Text",
        Rect: [x, 100, x + 20, 120],
        NM: PDFString.of(options.name ?? "client-id"),
        Contents: PDFHexString.fromText(options.text ?? "A shared note"),
        T: PDFHexString.fromText(options.author ?? "Forged Owner"),
        PapernookAuthor: PDFString.of("ana"),
        ...(options.type === "Highlight"
          ? { QuadPoints: [100, 120, 200, 120, 100, 100, 200, 100] }
          : {}),
      }),
    ),
  );
  return document.save();
}

export async function annotationDetails(bytes: Uint8Array) {
  const document = await PDFDocument.load(bytes);
  return (document.getPage(0).node.Annots()?.asArray() ?? []).map((ref) => {
    const value = document.context.lookup(ref, PDFDict);
    const string = (key: string) =>
      value.lookupMaybe(PDFName.of(key), PDFString, PDFHexString)?.decodeText();
    return {
      type: value.get(PDFName.of("Subtype"))?.toString(),
      text: string("Contents"),
      author: string("T"),
      actor: string("PapernookAuthor"),
      name: string("NM"),
    };
  });
}
