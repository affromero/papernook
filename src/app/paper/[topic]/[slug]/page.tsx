import { notFound, redirect } from "next/navigation";
import { activeProfile } from "@/lib/auth/session";
import { getPaper } from "@/lib/library/papers";
import { getProvider, hasConfiguredProvider } from "@/lib/agent/registry";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { ReadingWorkspace } from "@/components/chat/ReadingWorkspace";
import { PdfReader } from "@/components/pdf/PdfReader";
import { PaperHeader } from "@/components/paper/PaperHeader";
import styles from "./paper.module.css";

export const dynamic = "force-dynamic";

interface PaperPageProps {
  params: Promise<{ topic: string; slug: string }>;
}

export async function generateMetadata({ params }: PaperPageProps) {
  const { topic, slug } = await params;
  const paper = getPaper(topic, slug);
  return { title: paper ? paper.meta.title : "papernook" };
}

export default async function PaperPage({ params }: PaperPageProps) {
  const profile = await activeProfile();
  if (!profile) redirect("/login");
  const { topic, slug } = await params;
  const paper = getPaper(topic, slug);
  if (!paper) notFound();

  const meta = paper.meta;
  const aiAvailable = hasConfiguredProvider();
  const visionAvailable = aiAvailable && getProvider().capabilities.vision;
  return (
    <main className={styles.root}>
      <ReadingWorkspace
        mainLabel="Paper PDF"
        header={
          <PaperHeader topic={topic} slug={slug} meta={meta} view="reader" />
        }
        main={
          <PdfReader
            src={`/api/v1/papers/${topic}/${slug}/pdf`}
            title={meta.title}
            editable
            libraryLookup
          />
        }
        chat={
          <div className={styles.chat}>
            {paper.summary && <p className={styles.summary}>{paper.summary}</p>}
            <ChatPanel
              topic={topic}
              slug={slug}
              aiAvailable={aiAvailable}
              visionAvailable={visionAvailable}
            />
          </div>
        }
      />
    </main>
  );
}
