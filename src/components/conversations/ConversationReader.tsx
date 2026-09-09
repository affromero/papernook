"use client";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
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
  User,
} from "lucide-react";
import { DownloadButton } from "@/components/offline/DownloadButton";
import { useConnection } from "@/components/offline/useConnection";
import type { Conversation } from "@/lib/conversations/store";
import type { Chat } from "@/lib/library/chats";
import styles from "./ConversationView.module.css";
import readerStyles from "./ConversationReader.module.css";
import chatStyles from "@/components/chat/ChatPanel.module.css";
import pdfStyles from "@/components/pdf/PdfReader.module.css";
import {
  DocumentAppearanceSelect,
  useDocumentAppearance,
} from "@/components/chat/DocumentAppearance";

type TurnMessage = { role: "user" | "assistant"; content: string };

function ConversationInput({
  busy,
  connected,
  onSend,
}: {
  busy: boolean;
  connected: boolean;
  onSend: (query: string) => Promise<void>;
}) {
  const [query, setQuery] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy || !connected || !query.trim()) return;
    const value = query;
    setQuery("");
    await onSend(value);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (
      event.nativeEvent.isComposing ||
      event.key !== "Enter" ||
      event.shiftKey
    )
      return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <form
      className={chatStyles.inputRow}
      onSubmit={(event) => void submit(event)}
    >
      <textarea
        className={chatStyles.input}
        aria-label="Question"
        rows={2}
        required
        maxLength={40_000}
        value={query}
        placeholder="Ask about this conversation…"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
        disabled={busy}
      />
      <button
        className={chatStyles.sendBtn}
        disabled={busy || !connected || !query.trim()}
      >
        {busy ? "Thinking…" : "Send"}
      </button>
    </form>
  );
}

function ConversationTurns({
  messages,
  followUp = false,
}: {
  messages: TurnMessage[];
  followUp?: boolean;
}) {
  const groups: { start: number; messages: TurnMessage[] }[] = [];
  messages.forEach((message, index) => {
    const previous = groups.at(-1);
    if (previous?.messages[0].role === message.role) {
      previous.messages.push(message);
    } else {
      groups.push({ start: index, messages: [message] });
    }
  });
  return groups.map((group) =>
    group.messages.length === 1 ? (
      <ConversationTurn
        key={group.start}
        message={group.messages[0]}
        index={group.start}
        followUp={followUp}
      />
    ) : (
      <ConversationTurnGroup key={group.start} {...group} followUp={followUp} />
    ),
  );
}

function ConversationTurnGroup({
  messages,
  start,
  followUp,
}: {
  messages: TurnMessage[];
  start: number;
  followUp: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const label =
    messages[0].role === "user" ? (followUp ? "You" : "User") : "Assistant";
  return (
    <details
      className={`${readerStyles.turnGroup} ${followUp ? readerStyles.chatGroup : ""}`}
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary
        className={readerStyles.messageHeading}
        aria-label={`${label} turns ${start + 1} to ${start + messages.length}`}
      >
        <strong>
          {label} · {messages.length} messages
        </strong>
        <span>
          {start + 1}–{start + messages.length}
          <ChevronDown
            className={readerStyles.turnChevron}
            size={16}
            aria-hidden="true"
          />
        </span>
      </summary>
      <div className={readerStyles.groupMessages}>
        {messages.map((message, index) => (
          <ConversationTurn
            key={start + index}
            message={message}
            index={start + index}
            followUp={followUp}
          />
        ))}
      </div>
    </details>
  );
}

function ConversationTurn({
  message,
  index,
  followUp = false,
}: {
  message: TurnMessage;
  index: number;
  followUp?: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const label =
    message.role === "user" ? (followUp ? "You" : "User") : "Assistant";
  return (
    <details
      className={
        followUp
          ? `${readerStyles.chatMessage} ${message.role === "user" ? chatStyles.userMsg : chatStyles.assistantMsg}`
          : readerStyles.sourceMessage
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
  accountBar,
}: {
  conversation: Conversation;
  initialChats: Chat[];
  accountBar: ReactNode;
}) {
  const router = useRouter();
  const appearance = useDocumentAppearance();
  const connected = useConnection();
  const [chats, setChats] = useState(initialChats);
  const [chatId, setChatId] = useState(initialChats[0]?.header.id ?? "");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [readingProgress, setReadingProgress] = useState(0);
  const sourceRef = useRef<HTMLDivElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const base = `/api/v1/conversations/${conversation.id}`;
  useEffect(() => {
    const key = `papernook:offline-position:conversation:${conversation.id}:source`;
    const scrollElement = sourceRef.current;
    if (!scrollElement) return;
    const updateProgress = () => {
      const maximum = scrollElement.scrollHeight - scrollElement.clientHeight;
      setReadingProgress(
        maximum > 0 ? Math.round((scrollElement.scrollTop / maximum) * 100) : 0,
      );
    };
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
    scrollElement.addEventListener("scroll", updateProgress, { passive: true });
    updateProgress();
    return () => {
      scrollElement.removeEventListener("scroll", save);
      scrollElement.removeEventListener("scroll", updateProgress);
    };
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
  async function send(query: string): Promise<void> {
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
      <div className={readerStyles.mobileAccount}>{accountBar}</div>
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
            <div className={readerStyles.desktopAccount}>{accountBar}</div>
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
          <div className={pdfStyles.root} data-document-appearance={appearance}>
            <div
              className={`${pdfStyles.toolbar} ${readerStyles.documentToolbar}`}
            >
              <span>
                <BookOpen size={16} aria-hidden="true" /> Source transcript
              </span>
              <span>{conversation.messages.length} messages</span>
              <DocumentAppearanceSelect value={appearance} />
            </div>
            <progress
              className={readerStyles.readingProgress}
              max={100}
              value={readingProgress}
              aria-label={`Reading progress: ${readingProgress}%`}
            />
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
                <ConversationTurns messages={conversation.messages} />
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
            className={`${chatStyles.root} ${readerStyles.chatPanel}`}
            aria-label="Follow-up chats"
          >
            <div className={chatStyles.header}>
              <select
                className={chatStyles.chatSelect}
                aria-label="Follow-up chat"
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
              <button
                type="button"
                className={chatStyles.newBtn}
                disabled={busy}
                onClick={() => setChatId("")}
              >
                + New
              </button>
            </div>
            <div ref={chatScrollRef} className={chatStyles.messages}>
              {!active?.messages.length && !busy && (
                <p className={chatStyles.empty}>
                  Ask a question to explore the saved conversation.
                </p>
              )}
              <ConversationTurns
                key={chatId}
                messages={active?.messages ?? []}
                followUp
              />
              {draft && (
                <article className={chatStyles.assistantMsg}>
                  <h3 className={readerStyles.role}>Assistant</h3>
                  <Markdown
                    content={draft}
                    highlightCode={false}
                    copyCode={false}
                    currentOrigin=""
                  />
                </article>
              )}
            </div>
            {!connected && (
              <p role="status" className={readerStyles.caption}>
                Connect to continue this conversation. Your draft is preserved.
              </p>
            )}
            <ConversationInput
              busy={busy}
              connected={connected}
              onSend={send}
            />
          </section>
        }
      />
    </>
  );
}
