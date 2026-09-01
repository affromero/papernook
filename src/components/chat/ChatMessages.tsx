"use client";

import type { Bibliography } from "@/lib/pdf/bibliography";
import { Markdown } from "./Markdown";
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
  onDelete(index: number): void;
  onRegenerateThree(): void;
}

export function ChatMessages({
  messages,
  busy,
  vanishing,
  bibliography,
  currentOrigin,
  paperSourceUrl,
  visionAvailable,
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
