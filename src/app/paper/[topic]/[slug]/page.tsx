import { notFound, redirect } from "next/navigation";
import { activeProfile } from "@/lib/auth/session";
import { getPaper } from "@/lib/library/papers";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { ReadingWorkspace } from "@/components/chat/ReadingWorkspace";
import { PdfReader } from "@/components/pdf/PdfReader";
import { PaperHeader } from "@/components/paper/PaperHeader";
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
      <PaperHeader topic={topic} slug={slug} meta={meta} view="reader" />

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
          <div className={styles.chat}>
            {paper.summary && <p className={styles.summary}>{paper.summary}</p>}
            <ChatPanel topic={topic} slug={slug} />
          </div>
        }
      />
    </main>
  );
}
