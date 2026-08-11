import Link from "next/link";
import { AddPaperBox } from "./AddPaperBox";
import { ReviewStrip } from "./ReviewStrip";
import { ViewToggle } from "./ViewToggle";
import {
  allIndexed,
  searchIndex,
  allTags,
  type IndexedPaper,
} from "@/lib/library/index-db";
import {
  isPaperVisibleToProfile,
  matchesLibraryFilters,
} from "@/lib/library/citations/filters";
import { listTopics, listInbox } from "@/lib/library/papers";
import { listCaptureJobs } from "@/lib/capture/jobs";
import { CaptureJobs, type CaptureJobView } from "./CaptureJobs";
import { InboxCardDelete } from "./InboxCardDelete";
import { LibraryCitationExport } from "./LibraryCitationExport";
import styles from "./LibraryView.module.css";

interface LibraryViewProps {
  query: string;
  activeTag: string | null;
  activeTopic: string | null;
  captureToken: string;
  username: string;
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
  captureToken,
  username,
}: LibraryViewProps) {
  const papers = searchIndex(query)
    .filter((paper) => isPaperVisibleToProfile(paper, username))
    .filter((paper) =>
      matchesLibraryFilters(paper, {
        tag: activeTag,
        topic: activeTopic,
      }),
    );
  const topics = listTopics();
  const tags = allTags(username);
  // "done" markers are handles for the /add status page, not jobs to show;
  // the finished paper appears as a normal inbox card.
  const captureJobs: CaptureJobView[] = listCaptureJobs(username).flatMap(
    (job) =>
      job.state === "done"
        ? []
        : [
            {
              slug: job.slug,
              state: job.state,
              sourceUrl: job.sourceUrl,
              startedAt: job.startedAt,
              error: job.error,
            },
          ],
  );
  const inboxCount =
    listInbox().filter((paper) => paper.meta.addedBy === username).length +
    captureJobs.length;
  const flagged = allIndexed()
    .filter((p) => p.needsReview && p.topic !== null)
    .map((p) => ({ slug: p.slug, topic: p.topic as string, title: p.title }));

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
        <ViewToggle active="library" />
        <ReviewStrip flagged={flagged} topics={topics} />
        <AddPaperBox captureToken={captureToken} />
        <LibraryCitationExport
          query={query}
          tag={activeTag}
          topic={activeTopic}
        />
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

        {activeTopic === "_inbox" && <CaptureJobs jobs={captureJobs} />}
        {papers.length === 0 ? (
          activeTopic === "_inbox" && captureJobs.length > 0 ? null : (
            <p className={styles.empty}>
              {query
                ? "Nothing matches that search."
                : "No papers yet. Paste a link above to add your first."}
            </p>
          )
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
                {paper.topic === null && (
                  <InboxCardDelete slug={paper.slug} title={paper.title} />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
