import { isValidElement, type ReactNode } from "react";
import ReactMarkdown, { type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { rehypePaperRefs } from "@/lib/chat/ref-decorations";
import type { Bibliography } from "@/lib/pdf/bibliography";
import { ThreeSandbox } from "./ThreeSandbox";
import styles from "./Markdown.module.css";

/** Source of a ```threejs fence, if that's what this <pre> wraps. */
function threeCode(children: ReactNode): string | null {
  if (!isValidElement(children)) return null;
  const props = children.props as { className?: string; children?: ReactNode };
  if (!/\blanguage-threejs\b/.test(props.className ?? "")) return null;
  return typeof props.children === "string" ? props.children : null;
}

/**
 * Assistant-message renderer: GFM + $…$/$$…$$ KaTeX. Raw HTML stays dropped
 * (react-markdown default) and KaTeX keeps trust:false — AI output is
 * influenced by web-downloaded paper text, so nothing here may widen it.
 * renderThree swaps ```threejs fences for the sandboxed viewer; leave it
 * off while streaming (partial code) and on the public share page.
 * decorateRefs marks paper refs/citations as interactive buttons (handled
 * by the enclosing ChatPanel via delegation — this component stays
 * server-renderable); leave it off while streaming, it re-walks the whole
 * tree per chunk.
 */
export function Markdown({
  content,
  renderThree = false,
  decorateRefs = false,
  bibliography = null,
}: {
  content: string;
  renderThree?: boolean;
  decorateRefs?: boolean;
  bibliography?: Bibliography | null;
}) {
  // After rehypeKatex, so math text is never rewritten (the decorator also
  // skips katex subtrees — MathML annotations hold raw TeX).
  const rehypePlugins: Options["rehypePlugins"] = decorateRefs
    ? [rehypeKatex, [rehypePaperRefs, { bibliography }]]
    : [rehypeKatex];
  return (
    <div className={styles.root}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={rehypePlugins}
        components={
          renderThree
            ? {
                pre(props) {
                  const code = threeCode(props.children);
                  return code ? (
                    <ThreeSandbox code={code} />
                  ) : (
                    <pre>{props.children}</pre>
                  );
                },
              }
            : undefined
        }
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
