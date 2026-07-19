import { notFound, redirect } from "next/navigation";
import { activeProfile } from "@/lib/auth/session";
import { getPaper } from "@/lib/library/papers";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { ReadingWorkspace } from "@/components/chat/ReadingWorkspace";
import { PaperHeader } from "@/components/paper/PaperHeader";
import { CanvasClient } from "./CanvasClient";
import styles from "../paper.module.css";

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
      <PaperHeader topic={topic} slug={slug} meta={paper.meta} view="canvas" />
      <ReadingWorkspace
        mainLabel="Canvas"
        main={<CanvasClient topic={topic} slug={slug} />}
        chat={
          <div className={styles.chat}>
            {paper.summary && <p className={styles.summary}>{paper.summary}</p>}
            <ChatPanel topic={topic} slug={slug} />
          </div>
        }
      />
    </main>
  );
}
