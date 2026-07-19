import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { activeProfile } from "@/lib/auth/session";
import { getPaper } from "@/lib/library/papers";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { ReadingWorkspace } from "@/components/chat/ReadingWorkspace";
import { CitationActions } from "@/components/citations/CitationActions";
import { PdfReader } from "@/components/pdf/PdfReader";
import { ShareButton } from "@/components/share/ShareButton";
import styles from "./paper.module.css";

export const dynamic = "force-dynamic";

interface PaperPageProps {
  params: Promise<{ topic: string; slug: string }>;
}

export default async function PaperPage({ params }: PaperPageProps) {
  const profile = await activeProfile();
  if (!profile) redirect("/login");
  const { topic, slug } = await params;
  const paper = getPaper(topic, slug);
  if (!paper) notFound();

  const meta = paper.meta;
  return (
    <main className={styles.root}>
      <header className={styles.header}>
        <div className={styles.utilityRow}>
          <Link href="/" className={styles.back}>
            <span aria-hidden="true">←</span>
            Library
          </Link>
          <nav className={styles.actions} aria-label="Paper actions">
            <Link
              href={`/paper/${topic}/${slug}/canvas`}
              className={styles.actionLink}
            >
              Open canvas
            </Link>
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

      <ReadingWorkspace
        mainLabel="Paper PDF"
        main={
          <PdfReader
            src={`/api/v1/papers/${topic}/${slug}/pdf`}
            title={meta.title}
            editable
          />
        }
        chat={
          <div id="paper-chat-panel" className={styles.chat}>
            {paper.summary && <p className={styles.summary}>{paper.summary}</p>}
            <ChatPanel topic={topic} slug={slug} />
          </div>
        }
      />
    </main>
  );
}
