import { Parser } from "htmlparser2";
import { fenceCode } from "../format/code";

/** JSX brace attributes need a separator before the XML self-closing slash. */
export function layoutXml(source: string): string {
  return source.replace(/<(?:[^<>"']|"[^"]*"|'[^']*')+>/g, (tag) =>
    tag.endsWith("/>") ? `${tag.slice(0, -2)} />` : tag,
  );
}

/** Preserve complete provider containers before the prose normalizer runs. */
export function preserveShareLayouts(
  source: string,
  protect: (value: string) => string,
  restore: (value: string) => string,
): string {
  source = layoutXml(source);
  const ranges: { start: number; end: number }[] = [];
  let start = -1;
  let depth = 0;
  const parser = new Parser(
    {
      onopentag(name) {
        if (start < 0 && /^(box|grid|row)$/.test(name)) {
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
    result += source.slice(cursor, range.start);
    result += `\n\n${protect(fenceCode(restore(source.slice(range.start, range.end)), "share-layout"))}\n\n`;
    cursor = range.end;
  }
  return result + source.slice(cursor);
}
