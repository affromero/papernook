import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { activeProfile } from "@/lib/auth/session";
import { getPaper, listTopics } from "@/lib/library/papers";
import { InboxReview } from "./InboxReview";
import styles from "./inbox.module.css";

export const dynamic = "force-dynamic";

interface InboxPageProps {
  params: Promise<{ slug: string }>;
}

export default async function InboxPage({ params }: InboxPageProps) {
  const profile = await activeProfile();
  if (!profile) redirect("/login");
  const { slug } = await params;
  const paper = getPaper(null, slug);
  if (!paper || paper.meta.addedBy !== profile.username) notFound();

  return (
    <main className={styles.root}>
      <Link href="/?topic=_inbox" className={styles.back}>
        ← Inbox
      </Link>
      <p className={styles.eyebrow}>Awaiting confirmation</p>
      <h1>{paper.meta.title}</h1>
      <p className={styles.meta}>
        {paper.meta.authors.join(", ")}
        {paper.meta.year ? ` · ${paper.meta.year}` : ""}
      </p>
      {paper.summary && <p className={styles.summary}>{paper.summary}</p>}
      <InboxReview slug={slug} topics={listTopics()} />
    </main>
  );
}
