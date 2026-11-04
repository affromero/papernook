import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { isAccessError } from "thesidedoor-core/access";
import { ReadingWorkspace } from "@/components/chat/ReadingWorkspace";
import { CopySourceLinkButton } from "@/components/paper/CopySourceLinkButton";
import { PaperHeader } from "@/components/paper/PaperHeader";
import { PdfReader } from "@/components/pdf/PdfReader";
import { SharedImport } from "@/components/share/ImportReading";
import { PublicStudyArtifacts } from "@/components/share/StudyArtifacts";
import { SharedChat } from "@/components/share/SharedChat";
import { configuredCanvasLicense } from "@/lib/canvas/config";
import { getPaper } from "@/lib/library/papers";
import {
  getShare,
  withShareFiles,
  type PaperShare,
} from "@/lib/library/shares";
import paperStyles from "@/app/paper/[topic]/[slug]/paper.module.css";
import styles from "./share.module.css";

export const dynamic = "force-dynamic";

interface SharePageProps {
  params: Promise<{ topic: string; slug: string; shareId: string }>;
  searchParams?: Promise<{ view?: string }>;
}

export async function generateMetadata({
  params,
}: SharePageProps): Promise<Metadata> {
  const { topic, slug, shareId } = await params;
  const share = getShare(topic, slug, shareId);
  const paper = share ? getPaper(topic, slug) : null;
  return {
    title: paper?.meta.title ?? "papernook",
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

function cropUrl(share: PaperShare, imagePath: string): string | null {
  const match = imagePath.match(/^crops\/([^/]+)$/);
  if (!match) return null;
  return `/api/v1/shares/${share.topic}/${share.slug}/${share.id}/images/${encodeURIComponent(match[1])}`;
}

export default async function SharePage({
  params,
  searchParams,
}: SharePageProps) {
  const { topic, slug, shareId } = await params;
  const share = getShare(topic, slug, shareId);
  const paper = share ? getPaper(topic, slug) : null;
  if (!share || !paper) notFound();

  const canvasView =
    share.includeArtifacts && (await searchParams)?.view === "canvas";
  const shareHref = `/share/${topic}/${slug}/${shareId}`;

  const meta = paper.meta;
  const licenseKey = share.includeArtifacts
    ? configuredCanvasLicense().licenseKey
    : null;
  let currentOrigin: string | undefined;
  try {
    const headerStore = await headers();
    currentOrigin = `${headerStore.get("x-forwarded-proto") ?? "http"}://${headerStore.get("host") ?? "localhost"}`;
  } catch {
    // Direct server-component tests have no request store.
  }
  const conversations = share.conversations.map(({ header, messages }) => ({
    id: header.id,
    title: header.title,
    createdAt: header.createdAt,
    messages: messages.map((message) => ({
      role: message.role,
      content: message.content,
      images: (message.images ?? [])
        .map((path) => cropUrl(share, path))
        .filter((src): src is string => src !== null),
    })),
  }));

  try {
    return withShareFiles(share, () => (
      <main className={paperStyles.root}>
        <ReadingWorkspace
          mainLabel={
            canvasView ? "Shared canvas and exercises" : "Annotated paper"
          }
          header={
            <PaperHeader
              topic={topic}
              slug={slug}
              meta={meta}
              view={canvasView ? "canvas" : "reader"}
              sharedHref={shareHref}
              sharedCanvas={share.includeArtifacts}
            />
          }
          collapsedHeaderActions={
            <>
              <CopySourceLinkButton sourceUrl={meta.sourceUrl} />
              {share.includeArtifacts && (
                <Link
                  className={styles.viewLink}
                  href={canvasView ? shareHref : `${shareHref}?view=canvas`}
                >
                  {canvasView ? "Reader" : "Canvas"}
                </Link>
              )}
            </>
          }
          actions={
            <>
              <span className={styles.permission}>View only</span>
              <button
                type="button"
                className={styles.disabledAction}
                disabled
                title="Unavailable in a shared reading"
              >
                Share
              </button>
              <button
                type="button"
                className={styles.disabledAction}
                disabled
                title="Unavailable in a shared reading"
              >
                Save for offline
              </button>
              {share.mode !== "view" && <SharedImport mode={share.mode} />}
            </>
          }
          main={
            canvasView ? (
              <div className={styles.canvas}>
                <PublicStudyArtifacts
                  endpoint={`/api/v1/shares/${topic}/${slug}/${shareId}/artifacts`}
                  licenseKey={licenseKey}
                />
              </div>
            ) : (
              <PdfReader
                src={`/api/v1/shares/${topic}/${slug}/${shareId}/pdf`}
                title={meta.title}
                showReadonlyTools
                searchShortcut
              />
            )
          }
          chat={
            <div className={paperStyles.chat}>
              {share.includeArtifacts && !canvasView && (
                <PublicStudyArtifacts
                  endpoint={`/api/v1/shares/${topic}/${slug}/${shareId}/artifacts`}
                  licenseKey={licenseKey}
                />
              )}
              {paper.summary && (
                <p className={paperStyles.summary}>{paper.summary}</p>
              )}
              <SharedChat
                conversations={conversations}
                currentOrigin={currentOrigin}
                paperSourceUrl={meta.sourceUrl || undefined}
              />
            </div>
          }
        />
      </main>
    ));
  } catch (error) {
    if (isAccessError(error) && error.code === "unauthorized") notFound();
    throw error;
  }
}
