import { Parser } from "htmlparser2";
import { fenceCode } from "../format/code";
import { markdownRanges } from "../normalize-math";

/** JSX brace attributes need a separator before the XML self-closing slash. */
export function layoutXml(
  source: string,
  inserted?: (offset: number) => void,
): string {
  return source.replace(
    /<(?:[^<>"']|"[^"]*"|'[^']*')+>/g,
    (tag, offset: number) => {
      if (!tag.endsWith("/>")) return tag;
      inserted?.(offset + tag.length - 2);
      return `${tag.slice(0, -2)} />`;
    },
  );
}

/** Preserve complete provider containers before the prose normalizer runs. */
export function preserveShareLayouts(
  source: string,
  protect: (value: string) => string,
  restore: (value: string) => string,
): string {
  const original = source;
  const inserted: number[] = [];
  source = layoutXml(source, (offset) =>
    inserted.push(offset + inserted.length),
  );
  const literal = markdownRanges(source, new Set(["code", "inlineCode"]));
  function originalOffset(offset: number): number {
    let start = 0;
    let end = inserted.length;
    while (start < end) {
      const middle = Math.floor((start + end) / 2);
      if (inserted[middle] < offset) start = middle + 1;
      else end = middle;
    }
    return offset - start;
  }
  const ranges: { start: number; end: number }[] = [];
  let start = -1;
  let depth = 0;
  const parser = new Parser(
    {
      onopentag(name) {
        if (
          start < 0 &&
          /^(box|grid|row|favicon)$/i.test(name) &&
          !literal.some(
            (range) =>
              parser.startIndex >= range.start && parser.startIndex < range.end,
          )
        ) {
          start = parser.startIndex;
          depth = 0;
        }
        if (start >= 0) depth++;
      },
      onclosetag() {
        if (start < 0 || --depth > 0) return;
        ranges.push({ start, end: parser.endIndex + 1 });
        start = -1;
      },
    },
    { xmlMode: true, decodeEntities: false },
  );
  parser.end(source);
  let cursor = 0;
  let result = "";
  for (const range of ranges) {
    const start = originalOffset(range.start);
    const end = originalOffset(range.end);
    result += original.slice(cursor, start);
    result += `\n\n${protect(fenceCode(restore(original.slice(start, end)), "share-layout"))}\n\n`;
    cursor = end;
  }
  return result + original.slice(cursor);
}
