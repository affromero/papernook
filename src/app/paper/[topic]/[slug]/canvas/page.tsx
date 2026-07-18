import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { activeProfile } from "@/lib/auth/session";
import { getPaper } from "@/lib/library/papers";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { CanvasClient } from "./CanvasClient";
import styles from "./canvas.module.css";

export const dynamic = "force-dynamic";

interface CanvasPageProps {
  params: Promise<{ topic: string; slug: string }>;
}

export default async function CanvasPage({ params }: CanvasPageProps) {
  const profile = await activeProfile();
  if (!profile) redirect("/login");
  const { topic, slug } = await params;
  const paper = getPaper(topic, slug);
  if (!paper) notFound();

  return (
    <main className={styles.root}>
      <header className={styles.header}>
        <Link href={`/paper/${topic}/${slug}`} className={styles.back}>
          ← {paper.meta.title}
        </Link>
      </header>
      <div className={styles.columns}>
        <div className={styles.canvas}>
          <CanvasClient topic={topic} slug={slug} />
        </div>
        <aside className={styles.chat}>
          <ChatPanel topic={topic} slug={slug} />
        </aside>
      </div>
    </main>
  );
}
