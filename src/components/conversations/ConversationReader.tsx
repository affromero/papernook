"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Markdown } from "@/components/chat/Markdown";
import { ReadingWorkspace } from "@/components/chat/ReadingWorkspace";
import { LibraryNavigation } from "./LibraryNavigation";
import {
  BookOpen,
  Bot,
  ChevronDown,
  Download,
  ExternalLink,
  MessageSquare,
  Send,
  User,
} from "lucide-react";
import { DownloadButton } from "@/components/offline/DownloadButton";
import { useConnection } from "@/components/offline/useConnection";
import type { Conversation } from "@/lib/conversations/store";
import type { Chat } from "@/lib/library/chats";
import styles from "./ConversationView.module.css";
import readerStyles from "./ConversationReader.module.css";

function ConversationTurn({
  message,
  index,
  followUp = false,
}: {
  message: { role: "user" | "assistant"; content: string };
  index: number;
  followUp?: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const label =
    message.role === "user" ? (followUp ? "You" : "User") : "Assistant";
  return (
    <details
      className={
        followUp ? readerStyles.chatMessage : readerStyles.sourceMessage
      }
      data-message-role={message.role}
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary
        className={readerStyles.messageHeading}
        aria-label={`${label} turn ${index + 1}`}
      >
        <h3
          className={`${readerStyles.role} ${message.role === "user" ? readerStyles.userRole : readerStyles.assistantRole}`}
        >
          {message.role === "user" ? (
            <User size={13} aria-hidden="true" />
          ) : (
            <Bot size={13} aria-hidden="true" />
          )}
          {label}
        </h3>
        <span>
          {String(index + 1).padStart(2, "0")}{" "}
          <ChevronDown
            className={readerStyles.turnChevron}
            size={16}
            aria-hidden="true"
          />
        </span>
      </summary>
      <Markdown content={message.content} renderThree currentOrigin="" />
    </details>
  );
}
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
  const sourceRef = useRef<HTMLDivElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const base = `/api/v1/conversations/${conversation.id}`;
  useEffect(() => {
    const key = `papernook:offline-position:conversation:${conversation.id}:source`;
    const scrollElement = sourceRef.current;
    if (!scrollElement) return;
    try {
      const value = Number(localStorage.getItem(key));
      if (value > 0) scrollElement.scrollTop = value;
    } catch {}
    const save = () => {
      try {
        localStorage.setItem(key, String(scrollElement.scrollTop));
      } catch {}
    };
    scrollElement.addEventListener("scroll", save, { passive: true });
    return () => scrollElement.removeEventListener("scroll", save);
  }, [conversation.id]);
  useEffect(() => {
    const element = chatScrollRef.current;
    if (element)
      element.scrollTop =
        draft ||
        chats.find((chat) => chat.header.id === chatId)?.messages.length
          ? element.scrollHeight
          : 0;
  }, [draft, chatId, chats]);
  async function send(event: FormEvent) {
    event.preventDefault();
    if (busy || !query.trim()) return;
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
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <ReadingWorkspace
        mainLabel="Source transcript"
        workspaceLabel="Conversation workspace"
        actions={
          <DownloadButton
            snapshotUrl={`/api/v1/offline/conversations/${conversation.id}`}
          />
        }
        header={
          <header className={readerStyles.header}>
            <LibraryNavigation />
            <div className={readerStyles.headingRow}>
              <div>
                <h1>{conversation.title}</h1>
                <p className={readerStyles.caption}>
                  Saved {new Date(conversation.importedAt).toLocaleDateString()}{" "}
                  · {conversation.provider} · {conversation.messages.length}{" "}
                  messages · Private
                </p>
              </div>
              <div className={readerStyles.actions}>
                <details className={readerStyles.exportMenu}>
                  <summary>
                    <Download size={16} aria-hidden="true" /> Export
                  </summary>
                  <div>
                    <a
                      href={`${base}/export?format=html`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      HTML / Save as PDF
                    </a>
                    <a href={`${base}/export?format=markdown`}>Markdown</a>
                    <a href={`${base}/export?format=json`}>JSON</a>
                  </div>
                </details>
                {conversation.sourceUrl && (
                  <a
                    href={conversation.sourceUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    <ExternalLink size={16} aria-hidden="true" /> Original share
                  </a>
                )}
              </div>
            </div>
            <details className={readerStyles.metadata}>
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
                  <input
                    name="tags"
                    defaultValue={conversation.tags.join(", ")}
                  />
                </label>
                <button>Save details</button>
                <button
                  type="button"
                  className={readerStyles.deleteButton}
                  disabled={busy}
                  onClick={() => void remove()}
                >
                  Delete conversation
                </button>
              </form>
            </details>
          </header>
        }
        main={
          <div className={readerStyles.documentViewer}>
            <div className={readerStyles.documentToolbar}>
              <span>
                <BookOpen size={16} aria-hidden="true" /> Source transcript
              </span>
              <span>{conversation.messages.length} messages</span>
            </div>
            <div
              ref={sourceRef}
              className={readerStyles.documentScroll}
              tabIndex={0}
              aria-label="Scroll transcript"
            >
              <div className={readerStyles.paper}>
                <div className={readerStyles.documentTitle}>
                  <p className={readerStyles.eyebrow}>
                    Conversation · {conversation.provider}
                  </p>
                  <p className={readerStyles.paperTitle}>
                    {conversation.title}
                  </p>
                  <div className={readerStyles.tags}>
                    <span>{conversation.topic}</span>
                    {conversation.tags.map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                </div>
                {conversation.messages.map((message, index) => (
                  <ConversationTurn
                    key={index}
                    message={message}
                    index={index}
                  />
                ))}
                <footer className={readerStyles.documentFooter}>
                  End of saved conversation · {conversation.messages.length}{" "}
                  messages
                </footer>
              </div>
            </div>
          </div>
        }
        chat={
          <section
            className={readerStyles.chatPanel}
            aria-label="Follow-up chats"
          >
            <div className={readerStyles.chatHeader}>
              <h2>
                <MessageSquare size={18} aria-hidden="true" /> Study this
                conversation
              </h2>
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
            <div ref={chatScrollRef} className={readerStyles.chatMessages}>
              {!active?.messages.length && !busy && (
                <div className={readerStyles.emptyChat}>
                  <BookOpen size={28} aria-hidden="true" />
                  <p>Ask a question to explore the saved conversation.</p>
                </div>
              )}
              {active?.messages.map((message, index) => (
                <ConversationTurn
                  key={`${chatId}-${index}`}
                  message={message}
                  index={index}
                  followUp
                />
              ))}
              {draft && (
                <article className={readerStyles.chatMessage}>
                  <h3
                    className={`${readerStyles.role} ${readerStyles.assistantRole}`}
                  >
                    Assistant
                  </h3>
                  <Markdown
                    content={draft}
                    highlightCode={false}
                    copyCode={false}
                    currentOrigin=""
                  />
                </article>
              )}
              {busy && !draft && (
                <p role="status" className={readerStyles.caption}>
                  Thinking…
                </p>
              )}
            </div>
            <form
              className={readerStyles.composer}
              onSubmit={(event) => void send(event)}
            >
              <label>
                Question
                <textarea
                  required
                  maxLength={40_000}
                  value={query}
                  placeholder="Ask about this conversation…"
                  onChange={(event) => setQuery(event.target.value)}
                  disabled={busy}
                />
              </label>
              {!connected && (
                <p role="status">
                  Connect to continue this conversation. Your draft is
                  preserved.
                </p>
              )}
              <button disabled={busy || !connected || !query.trim()}>
                <Send size={16} aria-hidden="true" />{" "}
                {busy ? "Thinking…" : "Send"}
              </button>
            </form>
          </section>
        }
      />
    </>
  );
}
