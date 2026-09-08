"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Markdown } from "@/components/chat/Markdown";
import { DownloadButton } from "@/components/offline/DownloadButton";
import { useConnection } from "@/components/offline/useConnection";
import type { Conversation } from "@/lib/conversations/store";
import type { Chat } from "@/lib/library/chats";
import styles from "./ConversationView.module.css";
export function ConversationReader({
  conversation,
  initialChats,
}: {
  conversation: Conversation;
  initialChats: Chat[];
}) {
  const router = useRouter();
  const connected = useConnection();
  const [chats, setChats] = useState(initialChats);
  const [chatId, setChatId] = useState(initialChats[0]?.header.id ?? "");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sourceRef = useRef<HTMLElement>(null);
  const base = `/api/v1/conversations/${conversation.id}`;
  useEffect(() => {
    const key = `papernook:offline-position:conversation:${conversation.id}:source`;
    try {
      const value = Number(localStorage.getItem(key));
      if (value > 0) window.scrollTo(0, value);
    } catch {}
    const save = () => {
      try {
        localStorage.setItem(key, String(window.scrollY));
      } catch {}
    };
    window.addEventListener("scroll", save, { passive: true });
    return () => window.removeEventListener("scroll", save);
  }, [conversation.id]);
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!connected) {
      setError("Connect to continue this conversation.");
      return;
    }
    setBusy(true);
    setError("");
    setDraft("");
    try {
      const response = await fetch(`${base}/chats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, chatId: chatId || undefined }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Chat failed.");
      }
      if (!response.body)
        throw new Error("The server returned no reply stream.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let done = false;
      try {
        while (true) {
          const next = await reader.read();
          pending += decoder.decode(next.value, { stream: !next.done });
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            if (!line) continue;
            const data = JSON.parse(line);
            if (data.type === "error") throw new Error(data.error);
            if (data.type === "delta") setDraft((value) => value + data.text);
            if (data.type === "done") {
              const chat = data.chat as Chat;
              setChats((current) => [
                ...current.filter(
                  (value) => value.header.id !== chat.header.id,
                ),
                chat,
              ]);
              setChatId(chat.header.id);
              setQuery("");
              setDraft("");
              done = true;
            }
          }
          if (next.done) break;
        }
        if (!done)
          throw new Error(
            "The reply stream ended before saving. Retry your question.",
          );
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "Chat failed.");
    } finally {
      setBusy(false);
    }
  }
  async function metadata(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setError("");
    try {
      const response = await fetch(base, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: data.get("title"),
          topic: data.get("topic"),
          tags: String(data.get("tags") || "")
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean),
        }),
      });
      if (!response.ok) throw new Error((await response.json()).error);
      router.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Update failed.");
    }
  }
  async function remove() {
    if (
      !window.confirm(
        "Delete this imported conversation and its follow-up chats?",
      )
    )
      return;
    try {
      const response = await fetch(base, { method: "DELETE" });
      if (!response.ok) throw new Error((await response.json()).error);
      router.push("/conversations");
      router.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Delete failed.");
    }
  }
  const active = chats.find((chat) => chat.header.id === chatId);
  return (
    <>
      <h1>{conversation.title}</h1>
      <p>
        Saved {new Date(conversation.importedAt).toLocaleDateString()} ·{" "}
        {conversation.provider}. This source copy remains available if the
        original share is removed.
      </p>
      <div className={styles.actions}>
        <DownloadButton
          snapshotUrl={`/api/v1/offline/conversations/${conversation.id}`}
        />
        <a href={`${base}/export?format=html`}>Export HTML / Save as PDF</a>
        <a href={`${base}/export?format=markdown`}>Export Markdown</a>
        <a href={`${base}/export?format=json`}>Export JSON</a>
        {conversation.sourceUrl && (
          <a
            href={conversation.sourceUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            Original share
          </a>
        )}
        <button disabled={busy} onClick={() => void remove()}>
          Delete conversation
        </button>
      </div>
      <details>
        <summary>Edit title, topic and tags</summary>
        <form
          className={styles.form}
          onSubmit={(event) => void metadata(event)}
        >
          <label>
            Title
            <input
              name="title"
              defaultValue={conversation.title}
              required
              maxLength={200}
            />
          </label>
          <label>
            Topic
            <input
              name="topic"
              defaultValue={conversation.topic}
              required
              maxLength={80}
            />
          </label>
          <label>
            Tags
            <input name="tags" defaultValue={conversation.tags.join(", ")} />
          </label>
          <button>Save details</button>
        </form>
      </details>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <div className={styles.grid}>
        <section ref={sourceRef} aria-label="Source transcript">
          <h2>Source transcript</h2>
          {conversation.messages.map((message, index) => (
            <article key={index} className={styles.message}>
              <h3>{message.role === "user" ? "User" : "Assistant"}</h3>
              <Markdown content={message.content} currentOrigin="" />
            </article>
          ))}
        </section>
        <section aria-label="Follow-up chats">
          <h2>Study this conversation</h2>
          <div className={styles.form}>
            <label>
              Follow-up chat
              <select
                disabled={busy}
                value={chatId}
                onChange={(event) => setChatId(event.target.value)}
              >
                <option value="">New chat</option>
                {chats.map((chat) => (
                  <option key={chat.header.id} value={chat.header.id}>
                    {chat.header.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {active?.messages.map((message, index) => (
            <article className={styles.message} key={index}>
              <h3>{message.role === "user" ? "You" : "Assistant"}</h3>
              <Markdown content={message.content} currentOrigin="" />
            </article>
          ))}
          {draft && (
            <article className={styles.message}>
              <Markdown content={draft} currentOrigin="" />
            </article>
          )}
          <form className={styles.form} onSubmit={(event) => void send(event)}>
            <label>
              Question
              <textarea
                required
                maxLength={40_000}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                disabled={busy}
              />
            </label>
            {!connected && (
              <p role="status">
                Connect to continue this conversation. Your draft is preserved.
              </p>
            )}
            <button disabled={busy || !connected}>
              {busy ? "Thinking…" : "Send"}
            </button>
          </form>
        </section>
      </div>
    </>
  );
}
