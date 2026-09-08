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

export const STUDY_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; base-uri 'none'; form-action 'none'";
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

function safeLinks() {
  return (tree: Root) => {
    const visit = (node: Root | Element) => {
      for (const child of node.children) {
        if (child.type !== "element") continue;
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

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkRehype)
  .use(safeLinks)
  .use(rehypeKatex, { trust: false, strict: "ignore" })
  .use(rehypeHighlight, { detect: false, plainText: ["threejs"] })
  .use(rehypeStringify);

export function renderMarkdown(content: string): string {
  if (Buffer.byteLength(content) > 8 * 1024 * 1024)
    throw new Error("Study text exceeds the 8 MB limit.");
  return String(processor.processSync(normalizeMath(content)));
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

export function studyHtml(title: string, body: string): string {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(STUDY_CSP)}"><title>${escapeHtml(title)}</title><style>${mathCss()}body{max-width:900px;margin:auto;padding:24px;font:17px/1.6 system-ui,sans-serif;overflow-wrap:anywhere;color:#202020;background:white}pre{white-space:pre-wrap;background:#f4f4f4;padding:16px}code{font-family:monospace}table{border-collapse:collapse;display:block;overflow:auto}td,th{border:1px solid #aaa;padding:8px}img{max-width:100%;height:auto}.source-text{white-space:pre-wrap}.katex-display{overflow:auto}article{border-top:1px solid #bbb;margin-top:24px}@media print{body{padding:0;font-size:11pt}pre,table{overflow:visible}a{color:inherit}}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
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
    !/^crops\/[a-zA-Z0-9._-]+\.(png|jpe?g|webp|gif)$/i.test(relative)
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
