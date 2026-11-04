"use client";

import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { Markdown } from "@/components/chat/Markdown";
import styles from "@/components/chat/ChatPanel.module.css";

export interface SharedConversation {
  id: string;
  title: string;
  createdAt: string;
  messages: { role: "user" | "assistant"; content: string; images: string[] }[];
}

export function SharedChat({
  conversations,
  currentOrigin,
  paperSourceUrl,
}: {
  conversations: SharedConversation[];
  currentOrigin?: string;
  paperSourceUrl?: string;
}) {
  const [selected, setSelected] = useState(conversations[0]?.id ?? "");
  const conversation = conversations.find((item) => item.id === selected);
  return (
    <section className={styles.root} aria-label="Paper chat">
      <header className={styles.header}>
        <select
          className={styles.chatSelect}
          aria-label="Previous conversations"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
        >
          {conversations.length === 0 && (
            <option value="">No conversations shared</option>
          )}
          {conversations.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title} ·{" "}
              {new Date(item.createdAt).toLocaleDateString("en-US", {
                timeZone: "UTC",
              })}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={styles.renameChatBtn}
          disabled
          aria-label="Rename conversation"
          title="Unavailable in a shared reading"
        >
          <Pencil size={18} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={styles.deleteChatBtn}
          disabled
          aria-label="Delete conversation"
          title="Unavailable in a shared reading"
        >
          <Trash2 size={18} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={styles.newBtn}
          disabled
          title="Unavailable in a shared reading"
        >
          + New
        </button>
      </header>
      <div className={styles.messages}>
        {conversation ? (
          conversation.messages.map((message, index) => (
            <div
              key={`${conversation.id}-${index}`}
              data-message-role={message.role}
              className={
                message.role === "user" ? styles.userMsg : styles.assistantMsg
              }
            >
              {message.images.map((src) => (
                // Share-scoped images are authorized by the share endpoint.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={src}
                  className={styles.msgImage}
                  src={src}
                  alt="Conversation attachment"
                />
              ))}
              {message.role === "assistant" ? (
                <Markdown
                  content={message.content}
                  currentOrigin={currentOrigin}
                  paperSourceUrl={paperSourceUrl}
                />
              ) : (
                <p>{message.content}</p>
              )}
            </div>
          ))
        ) : (
          <p className={styles.empty}>
            The owner shared this paper without conversations.
          </p>
        )}
      </div>
      <div className={styles.inputRow}>
        <textarea
          className={styles.input}
          rows={2}
          disabled
          aria-label="Ask about the paper"
          placeholder="Ask about the paper…"
        />
        <button type="button" className={styles.sendBtn} disabled>
          Send
        </button>
      </div>
    </section>
  );
}
