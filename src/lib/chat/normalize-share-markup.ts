import type {
  ConversationAsset,
  ConversationCitation,
} from "@/lib/conversations/content";
import { htmlTableMarkdown } from "./format/table";
import {
  fenceCode,
  protectIndentedCode,
  protectMarkdownCode,
} from "./format/code";
import { preserveShareLayouts } from "./layout/share-layout-source";

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

/** Preserve display containers and translate inline provider components. */
export function normalizeShareMarkup(
  content: string,
  context: ShareMarkupContext = {},
): string {
  if (
    !/<(?:box|grid|row|favicon|Link|Entity|AsyncImage|Cite|MemoryCite|svg|table)\b/i.test(
      content,
    )
  )
    return content;
  const code = protectMarkdownCode(content);
  const protect = code.protect;
  let depth = 0;
  function prose(value: string): string {
    return value
      .replace(
        /<svg\b[^>]*>[\s\S]*?<\/svg>/g,
        (svg) =>
          `\n\n${protect(fenceCode(code.restore(svg), "svg-preview"))}\n\n`,
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
  const layouts = preserveShareLayouts(code.text, protect, code.restore);
  const remaining = protectIndentedCode(layouts, protect);
  const tables = remaining.replace(
    /(`+)[\s\S]*?\1(?!`)|<table\b[^>]*>[\s\S]*?<\/table>/gi,
    (match) =>
      match.startsWith("`") ? match : htmlTableMarkdown(code.restore(match)),
  );
  return code.restore(prose(tables.replace(/(`+)[\s\S]*?\1(?!`)/g, protect)));
}
