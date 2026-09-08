import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

interface SyntaxNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: SyntaxNode[];
}

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const protectedTypes = new Set([
  "code",
  "inlineCode",
  "html",
  "link",
  "image",
  "definition",
  "linkReference",
  "imageReference",
  "math",
  "inlineMath",
]);

/** Accept exported LaTeX delimiters without changing code or saved source. */
export function normalizeMath(content: string): string {
  if (!/\\[([]/.test(content)) return content;
  const protectedRanges: [number, number][] = [];
  function visit(node: SyntaxNode) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (
      protectedTypes.has(node.type) &&
      start !== undefined &&
      end !== undefined
    ) {
      protectedRanges.push([start, end]);
      return;
    }
    node.children?.forEach(visit);
  }
  visit(parser.parse(content));
  function convert(text: string) {
    return text.replace(
      /(?<!\\)\\\(([\s\S]*?)(?<!\\)\\\)|(?<!\\)\\\[([\s\S]*?)(?<!\\)\\\]/g,
      (
        match,
        inline: string | undefined,
        display: string | undefined,
        offset: number,
      ) => {
        const math = (inline ?? display ?? "").trim();
        if (!math || math.includes("$")) return match;
        if (inline !== undefined) return `$${math}$`;
        const before = text.slice(
          text.lastIndexOf("\n", offset - 1) + 1,
          offset,
        );
        const nextLine = text.indexOf("\n", offset + match.length);
        const after = text.slice(
          offset + match.length,
          nextLine < 0 ? text.length : nextLine,
        );
        // Keep equations embedded in list items and quotes in their container.
        if (before || after.trim()) return `$$${math}$$`;
        return `$$\n${math}\n$$`;
      },
    );
  }
  let cursor = 0;
  let result = "";
  for (const [start, end] of protectedRanges) {
    result += convert(content.slice(cursor, start)) + content.slice(start, end);
    cursor = end;
  }
  return result + convert(content.slice(cursor));
}
