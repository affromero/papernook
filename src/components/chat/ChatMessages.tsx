"use client";

import { useMemo } from "react";
import { StickyNote } from "lucide-react";
import { firstLocator, marginNoteText, wrapNote } from "@/lib/chat/margin-note";
import {
  requestMarginNote,
  type MarginNoteDetail,
} from "@/lib/chat/paper-ref-events";
import type { Bibliography } from "@/lib/pdf/bibliography";
import { Markdown } from "./Markdown";
import { MessageSources } from "./MessageSources";
import styles from "./ChatPanel.module.css";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  images?: string[];
  /** Server timestamp; absent on optimistic bubbles until the next reload. */
  at?: string;
}

interface ChatMessagesProps {
  messages: ChatMessage[];
  /** A send is streaming; the last assistant bubble is still growing. */
  busy: boolean;
  /** Indices mid-vanish animation, about to be removed. */
  vanishing: ReadonlySet<number>;
  bibliography: Bibliography | null;
  currentOrigin: string;
  paperSourceUrl?: string;
  visionAvailable: boolean;
  /** An editable PdfReader is mounted to receive "Save as note"; without
   * one the action would dispatch into the void. */
  marginNotes: boolean;
  onDelete(index: number): void;
  onRegenerateThree(): void;
}

/** Null when nothing in the answer survives the WinAnsi note format. */
function noteFor(markdown: string): MarginNoteDetail | null {
  const text = wrapNote(marginNoteText(markdown)).join("\n");
  return text ? { text, ref: firstLocator(markdown) } : null;
}

function NoteButton({ markdown }: { markdown: string }) {
  // The whole panel re-renders per keystroke in the composer; the note
  // pipeline only needs to run when the answer itself changes.
  const note = useMemo(() => noteFor(markdown), [markdown]);
  const label = note
    ? "Save as a shared note in the PDF (visible to everyone with this paper)"
    : "Nothing in this answer can be written as a PDF note";
  return (
    <button
      type="button"
      className={`${styles.deleteBtn} ${styles.noteBtn}`}
      onClick={() => note && requestMarginNote(note)}
      disabled={!note}
      aria-label={label}
      title={label}
    >
      <StickyNote aria-hidden="true" />
    </button>
  );
}

export function ChatMessages({
  messages,
  busy,
  vanishing,
  bibliography,
  currentOrigin,
  paperSourceUrl,
  visionAvailable,
  marginNotes,
  onDelete,
  onRegenerateThree,
}: ChatMessagesProps) {
  return (
    <>
      {messages.map((message, i) => (
        <div
          key={i}
          data-message-role={message.role}
          hidden={
            message.role === "assistant" &&
            !message.content.trim() &&
            !(busy && i === messages.length - 1)
          }
          className={[
            message.role === "user" ? styles.userMsg : styles.assistantMsg,
            vanishing.has(i) ? styles.vanish : "",
          ].join(" ")}
        >
          {message.at && !busy && (
            <button
              type="button"
              className={styles.deleteBtn}
              onClick={() => onDelete(i)}
              aria-label="Delete message"
              title="Delete message"
            >
              ×
            </button>
          )}
          {marginNotes &&
            message.at &&
            !busy &&
            message.role === "assistant" &&
            message.content.trim() && <NoteButton markdown={message.content} />}
          {message.images?.map((src, j) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={j}
              className={styles.msgImage}
              src={src.startsWith("data:") ? src : undefined}
              alt="attached crop"
            />
          ))}
          {message.role === "assistant" ? (
            message.content.trim() ? (
              <>
                <Markdown
                  content={message.content}
                  renderThree={!(busy && i === messages.length - 1)}
                  highlightCode={!(busy && i === messages.length - 1)}
                  copyCode={!(busy && i === messages.length - 1)}
                  decorateRefs={!(busy && i === messages.length - 1)}
                  bibliography={bibliography}
                  currentOrigin={currentOrigin}
                  paperSourceUrl={paperSourceUrl}
                  onRegenerateThree={onRegenerateThree}
                />
                {!(busy && i === messages.length - 1) && (
                  <MessageSources
                    content={message.content}
                    currentOrigin={currentOrigin}
                    paperSourceUrl={paperSourceUrl}
                  />
                )}
              </>
            ) : busy && i === messages.length - 1 ? (
              <span
                className={styles.typingIndicator}
                role="status"
                aria-label="Assistant is responding"
              >
                <span aria-hidden="true" />
                <span aria-hidden="true" />
                <span aria-hidden="true" />
              </span>
            ) : null
          ) : (
            <p>{message.content}</p>
          )}
        </div>
      ))}
      {messages.length === 0 && (
        <p className={styles.empty}>
          {visionAvailable
            ? "Ask anything about this paper, or paste a marked-up screenshot and ask “explain this”."
            : "Ask anything about this paper."}
        </p>
      )}
    </>
  );
}
