import Link from "next/link";
import { CitationActions } from "@/components/citations/CitationActions";
import { ShareButton } from "@/components/share/ShareButton";
import { ThemeToggle } from "@/components/profiles/ThemeToggle";
import type { PaperMeta } from "@/lib/library/papers";
import styles from "./PaperHeader.module.css";

interface PaperHeaderProps {
  topic: string;
  slug: string;
  meta: PaperMeta;
  view: "reader" | "canvas";
}

export function PaperHeader({ topic, slug, meta, view }: PaperHeaderProps) {
  const paperHref = `/paper/${topic}/${slug}`;
  return (
    <header className={styles.header}>
      <div className={styles.utilityRow}>
        <Link href="/" className={styles.back}>
          <span aria-hidden="true">←</span>
          Library
        </Link>
        <nav className={styles.viewToggle} aria-label="Paper view">
          <Link
            href={paperHref}
            aria-current={view === "reader" ? "page" : undefined}
          >
            Reader
          </Link>
          <Link
            href={`${paperHref}/canvas`}
            aria-current={view === "canvas" ? "page" : undefined}
          >
            Canvas
          </Link>
        </nav>
        <nav className={styles.actions} aria-label="Paper actions">
          <span className={styles.theme}>
            <ThemeToggle />
          </span>
          <ShareButton topic={topic} slug={slug} />
          <CitationActions topic={topic} slug={slug} />
        </nav>
      </div>
      <div className={styles.identity}>
        <p className={styles.eyebrow}>
          Paper <span aria-hidden="true">/</span> {topic.replaceAll("-", " ")}
        </p>
        <h1 className={styles.title}>{meta.title}</h1>
        <div className={styles.meta}>
          <p className={styles.authors}>{meta.authors.join(", ")}</p>
          {(meta.year || meta.venue) && (
            <p className={styles.publication}>
              {[meta.year, meta.venue].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>
      </div>
    </header>
  );
}
