import { csvParseRows, tsvParseRows } from "d3-dsv";
import { fenceCode } from "@/lib/chat/format/fence";
import { notebookTranscript } from "../formats/notebook";
import { documentSchema, type DocumentPreview } from "./schema";
import { officePreview } from "./office";

export function documentPreview(
  bytes: Uint8Array,
  name: string,
  mime: string,
): DocumentPreview {
  if (!bytes.length || bytes.length > 20 * 1024 * 1024)
    throw new Error("Attachment exceeds the 20 MB preview limit or is empty.");
  const prefix = new TextDecoder().decode(bytes.subarray(0, 8));
  if (prefix.startsWith("%PDF-")) return { kind: "pdf" };
  let result: DocumentPreview;
  if (prefix.startsWith("PK")) result = officePreview(bytes);
  else {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (source.length > 500_000)
      throw new Error(
        "Document text exceeds the preview limit. Download the original to read it.",
      );
    if (/\.(ipynb|json)$/i.test(name) || /(?:json|notebook)/i.test(mime)) {
      const value: unknown = JSON.parse(source);
      const notebook = notebookTranscript(value);
      result = notebook
        ? {
            kind: "notebook",
            content: notebook.map((message) => message.content).join("\n\n"),
          }
        : {
            kind: "document",
            sections: [
              { title: name, blocks: [{ kind: "text", text: source }] },
            ],
          };
    } else if (
      /\.csv$/i.test(name) ||
      /csv/i.test(mime) ||
      /\.tsv$/i.test(name) ||
      /tab-separated-values/.test(mime)
    ) {
      const rows =
        /\.tsv$/i.test(name) || /tab-separated-values/.test(mime)
          ? tsvParseRows(source)
          : csvParseRows(source);
      result = {
        kind: "document",
        sections: [{ title: name, blocks: [{ kind: "table", rows }] }],
      };
    } else if (/\.html?$/i.test(name) || /^text\/html/.test(mime))
      result = { kind: "artifact", format: "html-preview", content: source };
    else if (/\.svg$/i.test(name) || mime === "image/svg+xml")
      result = { kind: "artifact", format: "svg-preview", content: source };
    else if (/\.md$/i.test(name) || mime === "text/markdown")
      result = { kind: "notebook", content: source };
    else if (
      /^text\//.test(mime) ||
      /\.(txt|log|xml|yaml|yml|py|js|ts|tsx|jsx)$/i.test(name)
    )
      result = { kind: "notebook", content: fenceCode(source, "text") };
    else
      throw new Error(
        "This file format has no conversation preview. Download the original to open it.",
      );
  }
  if (JSON.stringify(result).length > 8 * 1024 * 1024)
    throw new Error("Expanded document exceeds the preview limit.");
  return documentSchema.parse(result);
}
