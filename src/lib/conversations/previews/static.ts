import { Parser } from "htmlparser2";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import type { Element, Root, RootContent } from "hast";
import { cardMarkdown } from "../formats/cards";
import { notebookPresentation } from "../formats/presentation";
import { prepareSvg } from "../preview";
import type { ShareMarkupContext } from "@/lib/chat/normalize-share-markup";
import { readPreview } from "./cache";
import { normalizeProviderText } from "@/lib/chat/normalize-provider-text";
import { rehypeShareLayouts } from "@/lib/chat/layout/rehype-share-layouts";

const allowed = new Set(
  "p div span h1 h2 h3 h4 h5 h6 table thead tbody tfoot tr th td caption ul ol li dl dt dd blockquote pre code strong em b i u s small sub sup br hr details summary a".split(
    " ",
  ),
);
const blocked = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "template",
  "head",
]);
const element = (tagName: string, children: RootContent[] = []): Element => ({
  type: "element",
  tagName,
  properties: {},
  children: children as Element["children"],
});

/** Portable HTML retains semantic content, never provider scripts, styling or remote resources. */
function staticHtml(source: string): RootContent[] {
  const root: Root = { type: "root", children: [] };
  const stack: Array<Root | Element> = [root];
  let hidden = 0;
  let count = 0;
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (++count > 20_000 || stack.length > 80)
          throw new Error("Static display exceeds the export structure limit.");
        if (hidden || blocked.has(name)) {
          hidden++;
          return;
        }
        const node = element(allowed.has(name) ? name : "span");
        if (name === "a" && /^https?:\/\//i.test(attributes.href ?? ""))
          node.properties = {
            href: attributes.href,
            rel: ["noopener", "noreferrer", "nofollow"],
          };
        stack.at(-1)!.children.push(node);
        stack.push(node);
      },
      ontext(value) {
        if (!hidden) stack.at(-1)!.children.push({ type: "text", value });
      },
      onclosetag() {
        if (hidden) hidden--;
        else if (stack.length > 1) stack.pop();
      },
    },
    { decodeEntities: true },
  );
  parser.end(source);
  return root.children;
}

function image(source: string, name: string): Element {
  return { ...element("img"), properties: { src: source, alt: name } };
}

export function staticPreview(
  kind: string,
  source: string,
  context: ShareMarkupContext & { base?: string },
): RootContent[] | null {
  const saved = context.base ? readPreview(context.base, kind, source) : null;
  if (saved)
    return [
      image(
        `data:image/png;base64,${saved.toString("base64")}`,
        "Saved visual output",
      ),
    ];
  if (kind === "svg-preview")
    return [
      image(
        `data:image/svg+xml;base64,${Buffer.from(prepareSvg(source)).toString("base64")}`,
        "Imported SVG diagram",
      ),
    ];
  if (kind === "card-preview") {
    const markdown = cardMarkdown(
      JSON.parse(source) as unknown,
      context.assets,
    );
    const pipeline = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkRehype)
      .use(rehypeShareLayouts, context);
    return pipeline.runSync(
      pipeline.parse(normalizeProviderText(markdown, context)),
    ).children;
  }
  if (kind === "html-preview") return staticHtml(source);
  if (kind === "notebook-preview") {
    const value = notebookPresentation(JSON.parse(source) as unknown);
    if (value.kind === "html") return staticHtml(String(value.value));
    if (value.kind === "svg")
      return [
        image(
          `data:image/svg+xml;base64,${Buffer.from(prepareSvg(String(value.value))).toString("base64")}`,
          "Notebook diagram",
        ),
      ];
    if (
      value.kind === "image" &&
      typeof value.value === "string" &&
      /^[A-Za-z0-9+/=\s]+$/.test(value.value)
    )
      return [
        image(
          `data:${value.mime};base64,${value.value.replace(/\s/g, "")}`,
          "Notebook output",
        ),
      ];
    if (value.kind === "text" || value.kind === "json")
      return [
        element("pre", [
          {
            type: "text",
            value:
              typeof value.value === "string"
                ? value.value
                : JSON.stringify(value.value, null, 2),
          },
        ]),
      ];
  }
  return null;
}
