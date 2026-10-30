import fs from "node:fs";
import path from "node:path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import rehypeStringify from "rehype-stringify";
import type { Root, Element } from "hast";
import { normalizeMath } from "@/lib/chat/normalize-math";
import { normalizeProviderText } from "@/lib/chat/normalize-provider-text";
import type { ShareMarkupContext } from "@/lib/chat/normalize-share-markup";
import { readAsset } from "@/lib/conversations/assets";
import { prepareSvg } from "@/lib/conversations/preview";
import { rehypeShareLayouts } from "@/lib/chat/layout/rehype-share-layouts";

export const STUDY_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; media-src data:; base-uri 'none'; form-action 'none'";
export const MAX_STUDY_BYTES = 32 * 1024 * 1024;

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}

export interface ExportMessageContext extends ShareMarkupContext {
  base?: string;
  messageIndex?: number;
}

function safeLinks(context: ExportMessageContext) {
  return (tree: Root) => {
    const visit = (node: Root | Element) => {
      for (const child of node.children) {
        if (child.type !== "element") continue;
        const source = String(
          child.properties.src ?? child.properties.href ?? "",
        );
        const index = /^#asset-(\d+)$/.exec(source)?.[1];
        const asset =
          index !== undefined ? context.assets?.[Number(index)] : undefined;
        if (asset && index !== undefined) {
          const saved = context.base
            ? readAsset(
                context.base,
                context.messageIndex ?? 0,
                Number(index),
                asset,
                true,
              )
            : null;
          if (!saved) {
            child.tagName = "span";
            child.properties = {};
            child.children = [
              {
                type: "text",
                value: `${asset.name}: attachment unavailable offline. Load it in the conversation before exporting.`,
              },
            ];
          } else {
            const uri = `data:${saved.mime};base64,${saved.bytes.toString("base64")}`;
            child.tagName =
              asset.kind === "image"
                ? "img"
                : asset.kind === "file"
                  ? "a"
                  : asset.kind;
            child.properties =
              asset.kind === "image"
                ? { src: uri, alt: asset.name }
                : asset.kind === "file"
                  ? { href: uri, download: asset.name }
                  : {
                      src: uri,
                      controls: true,
                      preload: "none",
                      ariaLabel: asset.name,
                    };
            child.children =
              asset.kind === "file"
                ? [{ type: "text", value: asset.name }]
                : [];
          }
          continue;
        }
        if (child.tagName === "pre") {
          const code = child.children[0];
          if (
            code?.type === "element" &&
            String(code.properties.className).includes("language-svg-preview")
          ) {
            const text = code.children
              .map((node) => (node.type === "text" ? node.value : ""))
              .join("");
            try {
              const svg = prepareSvg(text);
              child.tagName = "div";
              child.children = [
                {
                  type: "element",
                  tagName: "img",
                  properties: {
                    src: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
                    alt: "Imported SVG diagram",
                  },
                  children: [],
                },
              ];
              continue;
            } catch {
              // Preserve the source when the provider uses unsupported diagram syntax.
            }
          }
        }
        if (child.tagName === "img") {
          child.tagName = "span";
          child.children = [
            {
              type: "text",
              value: `Image unavailable offline: ${String(child.properties.alt || child.properties.src || "image")}`,
            },
          ];
          child.properties = {};
        }
        if (child.tagName === "a") {
          const href = String(child.properties.href || "");
          if (
            !/^https?:\/\//i.test(href) &&
            !/^mailto:/i.test(href) &&
            !href.startsWith("#")
          )
            delete child.properties.href;
          child.properties.rel = ["noreferrer", "noopener", "nofollow"];
        }
        visit(child);
      }
    };
    visit(tree);
  };
}

function processor(context: ExportMessageContext) {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkRehype)
    .use(rehypeShareLayouts, context)
    .use(safeLinks, context)
    .use(rehypeKatex, { trust: false, strict: "ignore" })
    .use(rehypeHighlight, { detect: false, plainText: ["threejs"] })
    .use(rehypeStringify);
}

export function renderMarkdown(
  content: string,
  context: ExportMessageContext = {},
): string {
  if (Buffer.byteLength(content) > 8 * 1024 * 1024)
    throw new Error("Study text exceeds the 8 MB limit.");
  return String(
    processor(context).processSync(
      normalizeMath(normalizeProviderText(content, context)),
    ),
  );
}

let embeddedCss: string | undefined;
function mathCss(): string {
  if (embeddedCss) return embeddedCss;
  const directory = path.join(process.cwd(), "node_modules", "katex", "dist");
  embeddedCss = fs
    .readFileSync(path.join(directory, "katex.min.css"), "utf8")
    .replace(/url\(([^)]+)\)/g, (_match, source: string) => {
      const relative = source.replace(/["']/g, "");
      if (!/^fonts\/[\w.-]+\.(woff2?|ttf)$/.test(relative))
        throw new Error("Unexpected math font path.");
      const extension = path.extname(relative).slice(1);
      return `url(data:font/${extension};base64,${fs.readFileSync(path.join(directory, relative)).toString("base64")})`;
    });
  return embeddedCss;
}

const sharedLayoutCss = `
[data-share-document]{margin:24px 0;font:inherit}
[data-share-layout]{min-width:0;max-width:100%;box-sizing:border-box}
[data-share-layout="box"]{display:flex;flex-direction:column}
[data-share-layout="grid"]{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}
[data-share-columns="1"]{grid-template-columns:minmax(0,1fr)}
[data-share-columns="3"]{grid-template-columns:repeat(3,minmax(0,1fr))}
[data-share-columns="4"]{grid-template-columns:repeat(4,minmax(0,1fr))}
[data-share-layout="row"]{display:flex;flex-wrap:wrap;align-items:center}
[data-share-layout] > p{margin:0}
[data-share-border]{border:1px solid #ccc}
[data-share-radius]{border-radius:12px}
[data-share-padding]{padding:20px}
[data-share-padding="1"]{padding:6px}
[data-share-padding="2"]{padding:12px}
[data-share-gap]{gap:16px}
[data-share-gap="1"]{gap:8px}
[data-share-gap="3"]{gap:24px}
[data-share-align="center"]{align-items:center}
[data-share-align="end"]{align-items:flex-end}
[data-share-justify="center"]{justify-content:center}
[data-share-justify="between"]{justify-content:space-between}
[data-share-textalign="center"]{text-align:center}
[data-share-width="full"]{width:100%}
[data-share-flex]{flex:1 1 0}
[data-share-background="surface"]{background:#f5f5f5}
[data-share-background="blue"]{background:#edf5f8}
[data-share-background="orange"]{background:#fbf3e9}
[data-share-background="green"]{background:#edf6f1}
[data-share-color="secondary"],[data-share-color="tertiary"]{color:#666}
[data-share-size="2xs"]{font-size:.72em;letter-spacing:.04em}
[data-share-size="xs"],[data-share-layout="caption"]{font-size:.82em}
[data-share-size="sm"]{font-size:.94em}
[data-share-weight="medium"]{font-weight:550}
[data-share-weight="bold"]{font-weight:700}
[data-share-layout="title"]{font-size:1.4em;font-weight:650}
[data-share-layout="badge"]{border:1px solid #bbb;border-radius:999px;padding:3px 10px;font-size:.8em;align-self:flex-start}
[data-share-swatch]{width:10px;height:10px}
[data-share-icon]{font-size:1.4em;line-height:1.3}
@media(max-width:600px){[data-share-layout="grid"]{grid-template-columns:minmax(0,1fr)}}
`;

export function studyHtml(title: string, body: string): string {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(STUDY_CSP)}"><title>${escapeHtml(title)}</title><style>${mathCss()}${sharedLayoutCss}body{max-width:900px;margin:auto;padding:24px;font:17px/1.6 system-ui,sans-serif;overflow-wrap:anywhere;color:#202020;background:white}pre{white-space:pre-wrap;background:#f4f4f4;padding:16px}code{font-family:monospace}table{border-collapse:collapse;display:block;overflow:auto}td,th{border:1px solid #aaa;padding:8px}img{max-width:100%;height:auto}.source-text{white-space:pre-wrap}.katex-display{overflow:auto}article{border-top:1px solid #bbb;margin-top:24px}@media print{body{padding:0;font-size:11pt}pre,table{overflow:visible}a{color:inherit}}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
  if (Buffer.byteLength(html) > MAX_STUDY_BYTES)
    throw new Error("Study export exceeds the 32 MB limit.");
  return html;
}

/** Only explicit local chat attachments enter exports. Markdown images never do. */
export function attachmentHtml(
  base: string | undefined,
  relative: string,
): string {
  const unavailable = `<p>Attachment unavailable: ${escapeHtml(relative)}</p>`;
  if (
    !base ||
    !/^(crops|attachments)\/[a-zA-Z0-9._-]+\.(png|jpe?g|webp|gif)$/i.test(
      relative,
    )
  )
    return unavailable;
  try {
    const root = fs.realpathSync(base);
    const file = fs.realpathSync(path.join(base, relative));
    if (!file.startsWith(`${root}${path.sep}`)) return unavailable;
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024)
      throw new Error("Attachment exceeds the 5 MB limit.");
    const bytes = fs.readFileSync(file);
    const mime = bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? "image/png"
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        ? "image/jpeg"
        : /^GIF8[79]a/.test(bytes.subarray(0, 6).toString())
          ? "image/gif"
          : bytes.subarray(0, 4).toString() === "RIFF" &&
              bytes.subarray(8, 12).toString() === "WEBP"
            ? "image/webp"
            : null;
    if (!mime) return unavailable;
    return `<img alt="${escapeHtml(relative)}" src="data:${mime};base64,${bytes.toString("base64")}">`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return unavailable;
    throw error;
  }
}
