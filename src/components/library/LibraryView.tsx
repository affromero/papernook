import Link from "next/link";
import {
  searchIndex,
  allTags,
  type IndexedPaper,
} from "@/lib/library/index-db";
import { listTopics, listInbox } from "@/lib/library/papers";
import styles from "./LibraryView.module.css";

interface LibraryViewProps {
  query: string;
  activeTag: string | null;
  activeTopic: string | null;
}

function matches(
  paper: IndexedPaper,
  tag: string | null,
  topic: string | null,
): boolean {
  if (tag && !paper.tags.includes(tag)) return false;
  if (topic === "_inbox") return paper.topic === null;
  if (topic && paper.topic !== topic) return false;
  return true;
}

function paperHref(paper: IndexedPaper): string {
  return paper.topic
    ? `/paper/${paper.topic}/${paper.slug}`
    : `/inbox/${paper.slug}`;
}

export function LibraryView({
  query,
  activeTag,
  activeTopic,
}: LibraryViewProps) {
  const papers = searchIndex(query).filter((p) =>
    matches(p, activeTag, activeTopic),
  );
  const topics = listTopics();
  const tags = allTags();
  const inboxCount = listInbox().length;

  return (
    <div className={styles.root}>
      <aside className={styles.sidebar}>
        <nav aria-label="Topics">
          <h2 className={styles.sideTitle}>Topics</h2>
          <ul className={styles.sideList}>
            <li>
              <Link
                className={
                  activeTopic === null ? styles.sideActive : styles.sideLink
                }
                href="/"
              >
                All papers
              </Link>
            </li>
            {topics.map((topic) => (
              <li key={topic}>
                <Link
                  className={
                    activeTopic === topic ? styles.sideActive : styles.sideLink
                  }
                  href={`/?topic=${encodeURIComponent(topic)}`}
                >
                  {topic}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        {inboxCount > 0 && (
          <Link className={styles.inboxBadge} href="/?topic=_inbox">
            Inbox · {inboxCount} awaiting
          </Link>
        )}
        {tags.length > 0 && (
          <nav aria-label="Tags">
            <h2 className={styles.sideTitle}>Tags</h2>
            <div className={styles.tagCloud}>
              {tags.map((tag) => (
                <Link
                  key={tag}
                  className={activeTag === tag ? styles.tagActive : styles.tag}
                  href={`/?tag=${encodeURIComponent(tag)}`}
                >
                  {tag}
                </Link>
              ))}
            </div>
          </nav>
        )}
      </aside>

      <section className={styles.main}>
        <form className={styles.searchRow} action="/" method="get">
          <input
            className={styles.search}
            type="search"
            name="q"
            defaultValue={query}
            placeholder="Search titles, authors, tags, full text…"
            aria-label="Search the library"
          />
        </form>

        {papers.length === 0 ? (
          <p className={styles.empty}>
            {query
              ? "Nothing matches that search."
              : "No papers yet — share a link to /add to start."}
          </p>
        ) : (
          <ul className={styles.grid}>
            {papers.map((paper) => (
              <li key={paper.slug} className={styles.card}>
                <Link className={styles.cardLink} href={paperHref(paper)}>
                  <h3 className={styles.cardTitle}>{paper.title}</h3>
                  <p className={styles.cardMeta}>
                    {paper.authors}
                    {paper.year ? ` · ${paper.year}` : ""}
                  </p>
                  {paper.summarySnippet && (
                    <p className={styles.cardSnippet}>{paper.summarySnippet}</p>
                  )}
                  <p className={styles.cardTags}>
                    {paper.topic === null && (
                      <span className={styles.cardInbox}>inbox</span>
                    )}
                    {paper.tags.map((tag) => (
                      <span key={tag} className={styles.cardTag}>
                        {tag}
                      </span>
                    ))}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
