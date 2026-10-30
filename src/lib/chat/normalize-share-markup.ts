import type {
  ConversationAsset,
  ConversationCitation,
} from "@/lib/conversations/content";

export interface ShareMarkupContext {
  assets?: ConversationAsset[];
  citations?: ConversationCitation[];
}

const layoutTags = new Set(["box", "grid", "grid-item", "row"]);
const blockTags = new Set(["text", "caption", "title"]);

function attribute(tag: string, name: string): string {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(
    tag,
  );
  return match?.[1] ?? match?.[2] ?? "";
}

function label(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_[\]{}]/g, "\\$&");
}
export function providerCitations(
  refs: string[],
  context?: ShareMarkupContext,
): string {
  return refs
    .map((ref) => context?.citations?.find((citation) => citation.ref === ref))
    .filter((citation): citation is ConversationCitation => Boolean(citation))
    .map(
      (citation) =>
        `[${label(citation.title)}](<${citation.url.replace(/>/g, "%3E")}>)`,
    )
    .join(" · ");
}

/** Translate ChatGPT's display components to inert Markdown, preserving code. */
export function normalizeShareMarkup(
  content: string,
  context: ShareMarkupContext = {},
): string {
  if (
    !/<(?:box|grid|row|Link|Entity|AsyncImage|Cite|MemoryCite|svg|table)\b/i.test(
      content,
    )
  )
    return content;
  const code: string[] = [];
  let prefix = "\u0000papernook-code:";
  while (content.includes(prefix)) prefix += ":";
  function protect(value: string): string {
    code.push(value);
    return `${prefix}${code.length - 1}\u0000`;
  }
  let depth = 0;
  function prose(value: string): string {
    return value
      .replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (table) => {
        const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(
          (row) =>
            [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(
              (cell) =>
                cell[1]
                  .replace(/<br\s*\/?\s*>/gi, " ")
                  .replace(/<[^>]*>/g, "")
                  .replace(/\|/g, "\\|")
                  .replace(/\s*\n\s*/g, " ")
                  .trim(),
            ),
        );
        if (!rows.length || !rows[0].length) return table;
        return `\n\n${[rows[0], rows[0].map(() => "---"), ...rows.slice(1)].map((row) => `| ${row.join(" | ")} |`).join("\n")}\n\n`;
      })
      .replace(
        /<svg\b[^>]*>[\s\S]*?<\/svg>/g,
        (svg) => `\n\n${protect(`\`\`\`svg-preview\n${svg}\n\`\`\``)}\n\n`,
      )
      .split("\n")
      .map((line) => {
        const insideLayout =
          depth > 0 || /<\/?(?:box|grid|grid-item|row)\b/.test(line);
        const result = line.replace(
          /<\/?(box|grid-item|grid|row|text|caption|title|badge|Link|Entity|AsyncImage|Cite|MemoryCite|icon|favicon|divider)\b(?:[^<>"']|"[^"]*"|'[^']*')*>/g,
          (tag: string, name: string) => {
            if (layoutTags.has(name)) {
              depth = Math.max(
                0,
                depth +
                  (tag.startsWith("</") ? -1 : tag.endsWith("/>") ? 0 : 1),
              );
              return "\n\n";
            }
            if (blockTags.has(name)) return "\n\n";
            if (name === "divider") return "\n\n---\n\n";
            if (name === "AsyncImage") {
              const ref = attribute(tag, "ref") || attribute(tag, "query");
              const index =
                context.assets?.findIndex(
                  (asset) => asset.kind === "image" && asset.ref === ref,
                ) ?? -1;
              return index >= 0
                ? `![${label(context.assets![index].name)}](#asset-${index})`
                : "[Image not included by the share provider]";
            }
            if (name === "Cite") {
              const refs = [...tag.matchAll(/turn[\w:-]+/g)].map(
                (match) => match[0],
              );
              return providerCitations(refs, context);
            }
            if (name === "Entity") return label(attribute(tag, "value"));
            if (name !== "Link" || tag.startsWith("</")) return "";
            const url = attribute(tag, "url");
            const title = label(attribute(tag, "title") || url);
            try {
              const parsed = new URL(url);
              if (!/^https?:$/.test(parsed.protocol)) return title;
              const href = parsed.href.replace(
                /[()<>]/g,
                (character) =>
                  `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
              );
              return `[${title}](${href})`;
            } catch {
              return title;
            }
          },
        );
        return insideLayout ? result.trimStart() : result;
      })
      .join("\n");
  }
  const lines = content.split("\n");
  let result = "";
  let start = 0;
  for (let index = 0; index < lines.length; index++) {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(lines[index])?.[1];
    if (!fence) continue;
    result += lines.slice(start, index).join("\n");
    if (index > start) result += "\n";
    start = index;
    const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`);
    while (++index < lines.length && !closing.test(lines[index])) {
      /* Preserve the complete code block. */
    }
    result += protect(lines.slice(start, index + 1).join("\n"));
    if (index < lines.length - 1) result += "\n";
    start = index + 1;
  }
  result += lines.slice(start).join("\n");
  const rendered = prose(result.replace(/(`+)[\s\S]*?\1(?!`)/g, protect));
  return rendered.replace(
    new RegExp(`${prefix}(\\d+)\u0000`, "g"),
    (_match, index: string) => code[Number(index)],
  );
}
