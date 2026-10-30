import {
  PDFDocument,
  PDFName,
  PDFString,
  PDFHexString,
  PDFDict,
  StandardFonts,
  rgb,
} from "pdf-lib";

export class ExerciseRenderError extends Error {}
export interface ExerciseRenderEntry {
  operationId: string;
  markdown: string;
}

interface Line {
  text: string;
  size: number;
  bold: boolean;
  indent: number;
}

/**
 * Helvetica is WinAnsi-only; pdf-lib throws on anything outside it. Chat
 * markdown now carries math and code, so transliterate common symbols and
 * blank out the rest rather than failing PDF generation.
 */
function sanitizeForWinAnsi(s: string): string {
  return s
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/[→⇒]/g, "->")
    .replace(/[←⇐]/g, "<-")
    .replace(/≤/g, "<=")
    .replace(/≥/g, ">=")
    .replace(/[^\n\x20-\x7E\u00A0-\u00FF]/g, "?");
}

function markdownToLines(markdown: string): Line[] {
  const lines: Line[] = [];
  // Fenced code (incl. ```threejs demos) is not Pencil practice material.
  const withoutFences = markdown.replace(
    /^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm,
    "[code block omitted]",
  );
  for (const raw of withoutFences.split("\n")) {
    const line = sanitizeForWinAnsi(raw.trimEnd());
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    const clean = (s: string) =>
      s
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/\*([^*]+)\*/g, "$1")
        .replace(/`([^`]+)`/g, "$1");
    if (heading) {
      lines.push({
        text: clean(heading[2]),
        size: heading[1].length === 1 ? 18 : 14,
        bold: true,
        indent: 0,
      });
    } else if (bullet) {
      lines.push({
        text: `• ${clean(bullet[1])}`,
        size: 11,
        bold: false,
        indent: 16,
      });
    } else if (numbered) {
      lines.push({
        text: `${numbered[1]}. ${clean(numbered[2])}`,
        size: 11,
        bold: false,
        indent: 16,
      });
    } else {
      lines.push({ text: clean(line), size: 11, bold: false, indent: 0 });
    }
  }
  return lines;
}

/** Append generated pages without rewriting existing page coordinates or ink. */
export async function renderExerciseDocument(
  title: string,
  entries: ExerciseRenderEntry[],
  current?: Uint8Array,
): Promise<Uint8Array> {
  if (
    entries.length > 100 ||
    entries.some(
      (entry) =>
        entry.markdown.length > 100_000 ||
        !/^[a-zA-Z0-9._-]{1,100}$/.test(entry.operationId),
    ) ||
    entries.reduce(
      (size, entry) => size + Buffer.byteLength(entry.markdown),
      0,
    ) >
      2 * 1024 * 1024 ||
    title.length > 2000 ||
    (current?.byteLength ?? 0) > 32 * 1024 * 1024
  )
    throw new ExerciseRenderError("Exercises exceed the rendering limits.");
  if (
    new Set(entries.map((entry) => entry.operationId)).size !== entries.length
  )
    throw new ExerciseRenderError("Duplicate exercise operation.");
  const trusted = current
    ? await PDFDocument.load(current, {
        updateMetadata: false,
        throwOnInvalidObject: true,
      })
    : null;
  const represented = new Set<string>();
  if (trusted) {
    for (const [, object] of trusted.context.enumerateIndirectObjects())
      if (
        object instanceof PDFDict &&
        (object.has(PDFName.of("ByteRange")) ||
          object.get(PDFName.of("Type")) === PDFName.of("Sig"))
      )
        throw new ExerciseRenderError(
          "Signed exercise PDFs cannot be changed.",
        );
    for (const page of trusted.getPages()) {
      const operation = page.node
        .lookupMaybe(
          PDFName.of("PapernookExerciseOperation"),
          PDFString,
          PDFHexString,
        )
        ?.decodeText();
      if (operation) represented.add(operation);
    }
  }
  const pending = entries.filter(
    (entry) => !represented.has(entry.operationId),
  );
  if (!pending.length && current) return current;
  if (!pending.length)
    throw new ExerciseRenderError("There are no exercises to render.");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pageSize: [number, number] = [595, 842]; // A4
  const margin = 56;
  const width = pageSize[0] - margin * 2;

  let page = doc.addPage(pageSize);
  let y = pageSize[1] - margin;

  const write = (line: Line) => {
    const face = line.bold ? bold : font;
    const words = line.text.split(/\s+/).filter(Boolean);
    let current = "";
    const flush = () => {
      if (y < margin + 20) {
        page = doc.addPage(pageSize);
        page.node.set(
          PDFName.of("PapernookExerciseOperation"),
          PDFString.of(operation),
        );
        y = pageSize[1] - margin;
      }
      page.drawText(current, {
        x: margin + line.indent,
        y,
        size: line.size,
        font: face,
        color: rgb(0.12, 0.13, 0.16),
      });
      // Extra leading: exercises are meant to be written on with a Pencil.
      y -= line.size * 2.1;
      current = "";
    };
    if (words.length === 0) {
      y -= line.size; // blank line
      return;
    }
    for (const word of words) {
      const attempt = current ? `${current} ${word}` : word;
      if (face.widthOfTextAtSize(attempt, line.size) > width - line.indent) {
        flush();
        current = word;
      } else {
        current = attempt;
      }
    }
    if (current) flush();
  };

  let operation = pending[0]!.operationId;
  for (const [index, entry] of pending.entries()) {
    operation = entry.operationId;
    if (index > 0) {
      page = doc.addPage(pageSize);
      y = pageSize[1] - margin;
    }
    page.node.set(
      PDFName.of("PapernookExerciseOperation"),
      PDFString.of(operation),
    );
    write({
      text: sanitizeForWinAnsi(`Exercises: ${title}`),
      size: 20,
      bold: true,
      indent: 0,
    });
    y -= 10;
    const markdown = entry.markdown;
    for (const line of markdownToLines(markdown)) write(line);
    y -= 24;
  }

  if (trusted)
    for (const page of await trusted.copyPages(doc, doc.getPageIndices()))
      trusted.addPage(page);
  const bytes = await (trusted ?? doc).save();
  if (bytes.byteLength > 32 * 1024 * 1024)
    throw new ExerciseRenderError(
      "The exercise PDF exceeds the 32 MB sharing limit.",
    );
  return bytes;
}
