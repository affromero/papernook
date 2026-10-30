import { Parser } from "htmlparser2";
import { markdownRanges, normalizeMath } from "../normalize-math";

const protectedTypes = new Set(["math", "inlineMath", "inlineCode"]);
function escapeText(value: string): string {
  return value.replace(
    /[\\|&<>]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character] ??
      `\\${character}`,
  );
}
function codeSpan(value: string): string {
  if (!value) return "";
  const lengths = [...value.matchAll(/`+/g)].map(
    (match) => match[0].length + 1,
  );
  const fence = "`".repeat(Math.max(1, ...lengths));
  const padding =
    /^`|`$/.test(value) || (/^ .* $/.test(value) && /[^ ]/.test(value))
      ? " "
      : "";
  return `${fence}${padding}${value}${padding}${fence}`;
}
function tableCode(value: string): string {
  let result = "";
  let segment = "";
  for (const character of value) {
    if (character !== "|") {
      segment += character;
      continue;
    }
    const slashes = /\\*$/.exec(segment)?.[0].length ?? 0;
    if (slashes % 2) {
      result += codeSpan(segment) + escapeText("|");
      segment = "";
    } else segment += "\\|";
  }
  return result + codeSpan(segment);
}

/** Serialize a cell without changing its code or mathematical notation. */
export function formatTableCell(value: string): string {
  const normalized = normalizeMath(value.replace(/\r?\n/g, " "));
  let cursor = 0;
  let result = "";
  for (const range of markdownRanges(normalized, protectedTypes)) {
    result += escapeText(normalized.slice(cursor, range.start));
    result +=
      range.type === "inlineCode"
        ? tableCode(range.value ?? "")
        : normalized
            .slice(range.start, range.end)
            .replace(/\\\||\|/g, (bar) =>
              bar.length === 2 ? "\\Vert " : "\\vert ",
            );
    cursor = range.end;
  }
  return result + escapeText(normalized.slice(cursor));
}

/** Read HTML table cells as text before serializing them as Markdown. */
export function htmlTableMarkdown(source: string): string {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell: string | null = null;
  const parser = new Parser({
    onopentag(name) {
      if (name === "tr") row = [];
      if (name === "td" || name === "th") cell = "";
      if (name === "br" && cell !== null) cell += " ";
    },
    ontext(text) {
      if (cell !== null) cell += text;
    },
    onclosetag(name) {
      if ((name === "td" || name === "th") && cell !== null) {
        row.push(formatTableCell(cell.trim()));
        cell = null;
      }
      if (name === "tr" && row.length) {
        rows.push(row);
        row = [];
      }
    },
  });
  parser.end(source);
  if (!rows.length) return source;
  return `\n\n${[rows[0], rows[0].map(() => "---"), ...rows.slice(1)].map((row) => `| ${row.join(" | ")} |`).join("\n")}\n\n`;
}
