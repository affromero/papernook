import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Markdown } from "@/components/chat/Markdown";
import { PdfReader } from "@/components/pdf/PdfReader";
import { getPaper } from "@/lib/library/papers";
import { getShare, type PaperShare } from "@/lib/library/shares";
import styles from "./share.module.css";

export const dynamic = "force-dynamic";

interface SharePageProps {
  params: Promise<{ topic: string; slug: string; shareId: string }>;
}

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

function cropUrl(share: PaperShare, imagePath: string): string | null {
  const match = imagePath.match(/^crops\/([^/]+)$/);
  if (!match) return null;
  return `/api/v1/shares/${share.topic}/${share.slug}/${share.id}/images/${encodeURIComponent(match[1])}`;
}

export default async function SharePage({ params }: SharePageProps) {
  const { topic, slug, shareId } = await params;
  const share = getShare(topic, slug, shareId);
  const paper = share ? getPaper(topic, slug) : null;
  if (!share || !paper) notFound();

  const meta = paper.meta;
  return (
    <main className={styles.root}>
      <header className={styles.masthead}>
        <div className={styles.brand}>papernook</div>
        <div className={styles.permission}>
          <span className={styles.lock} aria-hidden="true">
            ◇
          </span>
          View only
        </div>
      </header>

      <section className={styles.intro}>
        <p className={styles.eyebrow}>A shared reading</p>
        <h1 className={styles.title}>{meta.title}</h1>
        <p className={styles.meta}>
          {meta.authors.join(", ")}
          {meta.year ? ` · ${meta.year}` : ""}
          {meta.venue ? ` · ${meta.venue}` : ""}
        </p>
        <p className={styles.note}>
          You can read the current annotated paper and the conversation
          snapshots selected by its owner. This page cannot change the paper or
          continue the chats.
        </p>
      </section>

      <div className={styles.columns}>
        <section className={styles.paperColumn} aria-label="Annotated paper">
          <div className={styles.sectionLabel}>
            <span>Annotated paper</span>
            <span>Live copy</span>
          </div>
          <div className={styles.pdfFrame}>
            <PdfReader
              src={`/api/v1/shares/${topic}/${slug}/${shareId}/pdf`}
              title={meta.title}
            />
          </div>
        </section>

        <aside className={styles.studyColumn}>
          {paper.summary && (
            <section className={styles.summary}>
              <h2>Reading note</h2>
              <p>{paper.summary}</p>
            </section>
          )}

          <section className={styles.conversations}>
            <div className={styles.sectionLabel}>
              <span>Conversations</span>
              <span>
                {share.conversations.length} snapshot
                {share.conversations.length === 1 ? "" : "s"}
              </span>
            </div>
            {share.conversations.length === 0 ? (
              <p className={styles.empty}>
                The owner shared the annotated paper without conversations.
              </p>
            ) : (
              share.conversations.map((conversation, conversationIndex) => (
                <article
                  className={styles.conversation}
                  key={conversation.header.id}
                >
                  <h2>
                    <span>
                      {String(conversationIndex + 1).padStart(2, "0")}
                    </span>
                    {conversation.header.title}
                  </h2>
                  <div className={styles.messages}>
                    {conversation.messages.map((message, messageIndex) => (
                      <div
                        className={
                          message.role === "user"
                            ? styles.readerMessage
                            : styles.agentMessage
                        }
                        key={`${conversation.header.id}-${messageIndex}`}
                      >
                        <p className={styles.role}>
                          {message.role === "user" ? "Reader" : "Papernook"}
                        </p>
                        {message.images?.map((imagePath) => {
                          const src = cropUrl(share, imagePath);
                          return src ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              className={styles.crop}
                              src={src}
                              alt="Conversation attachment"
                              key={imagePath}
                            />
                          ) : null;
                        })}
                        {message.role === "assistant" ? (
                          <Markdown content={message.content} />
                        ) : (
                          <p className={styles.messageText}>
                            {message.content}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </article>
              ))
            )}
          </section>
        </aside>
      </div>

      <footer className={styles.footer}>
        Shared {new Date(share.createdAt).toLocaleDateString()} · The owner can
        revoke this link at any time.
      </footer>
    </main>
  );
}
