import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { activeProfile } from "@/lib/auth/session";
import { getPaper } from "@/lib/library/papers";
import { ChatPanel } from "@/components/chat/ChatPanel";
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
        <Link href="/" className={styles.back}>
          ← Library
        </Link>
        <Link href={`/paper/${topic}/${slug}/canvas`} className={styles.back}>
          Open canvas ↗
        </Link>
        <div>
          <h1 className={styles.title}>{meta.title}</h1>
          <p className={styles.meta}>
            {meta.authors.join(", ")}
            {meta.year ? ` · ${meta.year}` : ""}
            {meta.venue ? ` · ${meta.venue}` : ""} · {topic}
          </p>
        </div>
      </header>

      <div className={styles.columns}>
        <section className={styles.viewer} aria-label="Paper PDF">
          <iframe
            className={styles.pdfFrame}
            src={`/api/v1/papers/${topic}/${slug}/pdf`}
            title={meta.title}
          />
        </section>
        <aside className={styles.chat}>
          {paper.summary && <p className={styles.summary}>{paper.summary}</p>}
          <ChatPanel topic={topic} slug={slug} />
        </aside>
      </div>
    </main>
  );
}
