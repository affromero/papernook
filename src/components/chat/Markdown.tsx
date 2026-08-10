import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import styles from "./Markdown.module.css";

/**
 * Assistant-message renderer: GFM + $…$/$$…$$ KaTeX. Raw HTML stays dropped
 * (react-markdown default) and KaTeX keeps trust:false — AI output is
 * influenced by web-downloaded paper text, so nothing here may widen it.
 */
export function Markdown({ content }: { content: string }) {
  return (
    <div className={styles.root}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
