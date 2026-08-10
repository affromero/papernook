import fs from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { companionDir, exercisesPdfPath } from "./papers";

/**
 * Exercises: the agent (or the user, via "save as exercise") writes markdown
 * into the companion folder; we render all of them into one
 * <slug>.exercises.pdf in the papers tree so they reach the iPad
 * Pencil-annotatable over WebDAV. The renderer handles the markdown subset
 * chat output actually uses: headings, bullets, numbered lists, paragraphs,
 * with generous line spacing left as writing room.
 */

export function saveExercise(
  topic: string,
  slug: string,
  markdown: string,
): string {
  const dir = path.join(companionDir(topic, slug), "exercises");
  fs.mkdirSync(dir, { recursive: true });
  const existing = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  const name = `practice-${existing.length + 1}.md`;
  fs.writeFileSync(path.join(dir, name), markdown);
  return name;
}

export function listExercises(topic: string, slug: string): string[] {
  const dir = path.join(companionDir(topic, slug), "exercises");
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
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
 * blank out the rest rather than 500 on "save as exercise".
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

/** Render every exercise markdown into one Pencil-friendly PDF. */
export async function renderExercisesPdf(
  topic: string,
  slug: string,
  title: string,
): Promise<string | null> {
  const names = listExercises(topic, slug);
  if (names.length === 0) return null;
  const dir = path.join(companionDir(topic, slug), "exercises");

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

  write({ text: `Exercises: ${title}`, size: 20, bold: true, indent: 0 });
  y -= 10;
  for (const name of names) {
    const markdown = fs.readFileSync(path.join(dir, name), "utf8");
    for (const line of markdownToLines(markdown)) write(line);
    y -= 24;
  }

  const bytes = await doc.save();
  const out = exercisesPdfPath(topic, slug);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, out);
  return out;
}
