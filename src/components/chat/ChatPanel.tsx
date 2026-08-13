"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  BIBLIOGRAPHY_EVENT,
  PAPER_REF_EVENT,
  detailFromDataset,
  type PaperRefAction,
} from "@/lib/chat/paper-ref-events";
import type { Bibliography } from "@/lib/pdf/bibliography";
import { Markdown } from "./Markdown";
import styles from "./ChatPanel.module.css";

interface ChatHeader {
  id: string;
  title: string;
  createdAt: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  images?: string[];
  /** Server timestamp; absent on optimistic bubbles until the next reload. */
  at?: string;
}

interface ChatPanelProps {
  topic: string;
  slug: string;
  currentOrigin: string;
  /** Server-computed hasConfiguredProvider(); false renders a setup hint. */
  aiAvailable: boolean;
  /** Provider capabilities.vision; false disables image attachments. */
  visionAvailable: boolean;
}

export function ChatPanel({
  topic,
  slug,
  currentOrigin,
  aiAvailable,
  visionAvailable,
}: ChatPanelProps) {
  const base = `/api/v1/papers/${topic}/${slug}`;
  const [chats, setChats] = useState<ChatHeader[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [pastedImages, setPastedImages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [vanishing, setVanishing] = useState<ReadonlySet<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [bibliography, setBibliography] = useState<Bibliography | null>(null);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historySelection, setHistorySelection] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const historyDialogRef = useRef<HTMLDialogElement>(null);
  const historySearchRef = useRef<HTMLInputElement>(null);
  const historyResultsRef = useRef<HTMLDivElement>(null);
  const historyDraftRef = useRef("");
  const pickerDraftRef = useRef("");
  const refHoverTimerRef = useRef<number | null>(null);
  const openRequestRef = useRef(0);
  const historyTitleId = useId();

  const sentHistory = messages.reduce<string[]>((history, message) => {
    if (message.role === "user") history.unshift(message.content);
    return history;
  }, []);
  const normalizedHistoryQuery = historyQuery.trim().toLocaleLowerCase();
  const filteredHistory = normalizedHistoryQuery
    ? sentHistory.filter((message) =>
        message.toLocaleLowerCase().includes(normalizedHistoryQuery),
      )
    : sentHistory;

  useEffect(() => {
    void fetch(`${base}/chats`, { credentials: "include" })
      .then((r) => r.json())
      .then((d: { chats?: ChatHeader[] }) => {
        setChats(d.chats ?? []);
        if (d.chats?.[0]) void openChat(d.chats[0].id);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic, slug]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  useEffect(() => {
    if (!historyDialogRef.current?.open) return;
    historyResultsRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [historyQuery, historySelection]);

  // Canvas "Explain selection" hands crops over via this window event.
  useEffect(() => {
    if (!visionAvailable) return;
    const onAttach = (event: Event) => {
      const dataUrl = (event as CustomEvent<string>).detail;
      if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/")) {
        setPastedImages((imgs) => [...imgs, dataUrl].slice(0, 4));
      }
    };
    window.addEventListener("papernook:attach", onAttach);
    return () => window.removeEventListener("papernook:attach", onAttach);
  }, [visionAvailable]);

  // PdfReader publishes the scanned bibliography once per document; with it
  // in hand, Markdown decorates resolvable citations as interactive.
  useEffect(() => {
    const onBibliography = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (
        detail &&
        typeof detail === "object" &&
        "style" in detail &&
        "entries" in detail &&
        Array.isArray((detail as { entries: unknown }).entries)
      ) {
        setBibliography(detail as Bibliography);
      }
    };
    window.addEventListener(BIBLIOGRAPHY_EVENT, onBibliography);
    return () => {
      window.removeEventListener(BIBLIOGRAPHY_EVENT, onBibliography);
      clearRefHover();
    };
  }, []);

  function clearRefHover(): void {
    if (refHoverTimerRef.current !== null) {
      window.clearTimeout(refHoverTimerRef.current);
      refHoverTimerRef.current = null;
    }
  }

  function dispatchRef(target: EventTarget | null, action: PaperRefAction) {
    const button =
      target instanceof Element
        ? target.closest<HTMLButtonElement>(
            "button[data-paper-ref], button[data-citation]",
          )
        : null;
    if (!button) return false;
    const detail = detailFromDataset(button.dataset, action);
    if (!detail) return false;
    window.dispatchEvent(new CustomEvent(PAPER_REF_EVENT, { detail }));
    return true;
  }

  // Same interaction grammar as the PDF's own citation hotspots: mouse
  // dwell (180ms) previews, click commits — navigation for in-paper refs,
  // preview for citations (their click IS the preview, matching the PDF).
  function onRefHover(event: PointerEvent<HTMLDivElement>): void {
    if (event.pointerType !== "mouse") return;
    const target = event.target;
    clearRefHover();
    refHoverTimerRef.current = window.setTimeout(() => {
      dispatchRef(target, "preview");
    }, 180);
  }

  function onRefClick(event: React.MouseEvent<HTMLDivElement>): void {
    clearRefHover();
    dispatchRef(event.target, "goto");
  }

  function focusComposerAtEnd(): void {
    window.requestAnimationFrame(() => {
      const textarea = inputRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
  }

  function resetHistoryNavigation(): void {
    setHistoryIndex(null);
    historyDraftRef.current = "";
  }

  function closeHistorySearch(restoreDraft: boolean): void {
    if (restoreDraft) setInput(pickerDraftRef.current);
    historyDialogRef.current?.close();
    setHistoryQuery("");
    setHistorySelection(0);
    pickerDraftRef.current = "";
    focusComposerAtEnd();
  }

  function resetHistory(): void {
    resetHistoryNavigation();
    if (historyDialogRef.current?.open) historyDialogRef.current.close();
    setHistoryQuery("");
    setHistorySelection(0);
    pickerDraftRef.current = "";
  }

  function recallHistory(index: number): void {
    const message = sentHistory[index];
    if (message === undefined) return;
    setHistoryIndex(index);
    setInput(message);
    focusComposerAtEnd();
  }

  function navigateHistory(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      (event.key !== "ArrowUp" && event.key !== "ArrowDown")
    ) {
      return false;
    }

    if (historyIndex === null) {
      if (event.key === "ArrowDown" || sentHistory.length === 0) return false;
      const textarea = event.currentTarget;
      const selectionIsCollapsed =
        textarea.selectionStart === textarea.selectionEnd;
      const isAtHistoryBoundary =
        input.length === 0 ||
        (selectionIsCollapsed && textarea.selectionStart === 0);
      if (!isAtHistoryBoundary) return false;
      historyDraftRef.current = input;
      recallHistory(0);
      return true;
    }

    if (event.key === "ArrowUp") {
      recallHistory(Math.min(historyIndex + 1, sentHistory.length - 1));
      return true;
    }

    if (historyIndex > 0) {
      recallHistory(historyIndex - 1);
    } else {
      setHistoryIndex(null);
      setInput(historyDraftRef.current);
      focusComposerAtEnd();
    }
    return true;
  }

  function openHistorySearch(): void {
    const dialog = historyDialogRef.current;
    if (!dialog || dialog.open) return;
    pickerDraftRef.current = input;
    setHistoryQuery("");
    setHistorySelection(0);
    dialog.showModal();
    window.requestAnimationFrame(() => historySearchRef.current?.focus());
  }

  function selectHistoryMessage(message: string): void {
    resetHistoryNavigation();
    setInput(message);
    closeHistorySearch(false);
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (
      event.key.toLocaleLowerCase() === "r" &&
      event.ctrlKey &&
      !event.altKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      openHistorySearch();
      return;
    }
    if (navigateHistory(event)) {
      event.preventDefault();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  function onHistorySearchKeyDown(
    event: KeyboardEvent<HTMLInputElement>,
  ): void {
    if (event.key === "Escape") {
      event.preventDefault();
      closeHistorySearch(true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setHistorySelection((index) =>
        Math.min(index + 1, Math.max(filteredHistory.length - 1, 0)),
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHistorySelection((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const message = filteredHistory[historySelection];
      if (message !== undefined) selectHistoryMessage(message);
    }
  }

  async function openChat(id: string): Promise<void> {
    const request = ++openRequestRef.current;
    resetHistory();
    setActiveId(id);
    setMessages([]);
    const res = await fetch(`${base}/chats/${id}`, { credentials: "include" });
    const data = (await res.json()) as {
      chat?: { header: ChatHeader; messages: ChatMessage[] };
    };
    if (request !== openRequestRef.current) return;
    const header = data.chat?.header;
    if (header) {
      setChats((current) =>
        current.map((chat) => (chat.id === header.id ? header : chat)),
      );
    }
    setMessages(data.chat?.messages ?? []);
    setVanishing(new Set());
  }

  /** iOS-style vanish: shrink the bubble, then remove it here and on disk. */
  function deleteMsg(index: number): void {
    const chatId = activeId;
    const at = messages[index]?.at;
    if (!chatId || !at || busy) return;
    setVanishing((v) => new Set(v).add(index));
    window.setTimeout(() => {
      void (async () => {
        const res = await fetch(`${base}/chats/${chatId}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ index, at }),
        }).catch(() => null);
        setVanishing(new Set());
        if (res?.ok) {
          setMessages((m) => m.filter((_, i) => i !== index));
          resetHistory();
        } else {
          // ponytail: stale index (e.g. two rapid deletes) → resync from disk.
          setError("Delete failed.");
          void openChat(chatId);
        }
      })();
    }, 220);
  }

  async function newChat(): Promise<string | null> {
    const res = await fetch(`${base}/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({}),
    });
    const data = (await res.json()) as { chat?: ChatHeader };
    if (data.chat) {
      ++openRequestRef.current;
      resetHistory();
      setChats((c) => [data.chat as ChatHeader, ...c]);
      setActiveId(data.chat.id);
      setMessages([]);
      return data.chat.id;
    }
    return null;
  }

  function onPaste(event: React.ClipboardEvent): void {
    if (!visionAvailable) return;
    for (const item of event.clipboardData.items) {
      if (!item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (!file) continue;
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") {
          setPastedImages((imgs) =>
            [...imgs, reader.result as string].slice(0, 4),
          );
        }
      };
      reader.readAsDataURL(file);
    }
  }

  async function send(): Promise<void> {
    const content = input.trim();
    if (!content || busy) return;
    let chatId = activeId;
    if (!chatId) {
      chatId = await newChat();
      if (!chatId) return;
    }
    setBusy(true);
    setError(null);
    setInput("");
    resetHistory();
    const images = pastedImages;
    setPastedImages([]);
    setMessages((m) => [
      ...m,
      { role: "user", content, images: images.length ? images : undefined },
      { role: "assistant", content: "" },
    ]);
    try {
      const res = await fetch(`${base}/chats/${chatId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          content,
          images: images.length ? images : undefined,
        }),
      });
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Send failed.");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        setMessages((m) => {
          const next = [...m];
          const last = next[next.length - 1];
          next[next.length - 1] = { ...last, content: last.content + chunk };
          return next;
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Send failed.");
    } finally {
      setBusy(false);
      // Reload from disk so the new bubbles carry their server timestamps
      // (needed to delete them) and a failed send drops nothing silently.
      void openChat(chatId);
    }
  }

  return (
    <section className={styles.root} aria-label="Paper chat">
      <header className={styles.header}>
        <select
          className={styles.chatSelect}
          value={activeId ?? ""}
          onChange={(e) => void openChat(e.target.value)}
          aria-label="Previous conversations"
        >
          {chats.length === 0 && <option value="">No conversations yet</option>}
          {chats.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title} · {new Date(c.createdAt).toLocaleDateString()}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={styles.newBtn}
          disabled={!aiAvailable}
          onClick={() => void newChat()}
        >
          + New
        </button>
      </header>

      <div
        className={styles.messages}
        ref={scrollRef}
        onClick={onRefClick}
        onPointerOver={onRefHover}
        onPointerOut={clearRefHover}
      >
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
                onClick={() => deleteMsg(i)}
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
      </div>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {pastedImages.length > 0 && (
        <div className={styles.pastedRow}>
          {pastedImages.map((src, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={i}
              className={styles.pastedThumb}
              src={src}
              alt="pasted"
            />
          ))}
          <button type="button" onClick={() => setPastedImages([])}>
            clear
          </button>
        </div>
      )}

      {aiAvailable ? (
        <div className={styles.inputRow}>
          <textarea
            ref={inputRef}
            className={styles.input}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              resetHistoryNavigation();
            }}
            onPaste={onPaste}
            onKeyDown={onComposerKeyDown}
            placeholder={
              visionAvailable
                ? "Ask about the paper… (paste screenshots here)"
                : "Ask about the paper…"
            }
            rows={2}
          />
          <button
            type="button"
            className={styles.sendBtn}
            onClick={() => void send()}
            disabled={busy || input.trim().length === 0}
          >
            Send
          </button>
        </div>
      ) : (
        <p className={styles.empty}>
          Chat needs an AI provider. Connect one in Settings — everything else
          works without it.
        </p>
      )}

      <dialog
        ref={historyDialogRef}
        className={styles.historyDialog}
        aria-labelledby={historyTitleId}
        onCancel={(event) => {
          event.preventDefault();
          closeHistorySearch(true);
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeHistorySearch(true);
        }}
      >
        <div className={styles.historyDialogInner}>
          <header className={styles.historyHeader}>
            <div>
              <p className={styles.historyShortcut}>Ctrl R</p>
              <h2 id={historyTitleId}>Search sent messages</h2>
            </div>
            <button
              type="button"
              className={styles.historyClose}
              aria-label="Close message history"
              onClick={() => closeHistorySearch(true)}
            >
              ×
            </button>
          </header>
          <input
            ref={historySearchRef}
            className={styles.historySearch}
            type="search"
            value={historyQuery}
            onChange={(event) => {
              setHistoryQuery(event.target.value);
              setHistorySelection(0);
            }}
            onKeyDown={onHistorySearchKeyDown}
            placeholder="Type to filter this chat…"
            aria-label="Filter sent messages"
            aria-controls={`${historyTitleId}-results`}
            aria-activedescendant={
              filteredHistory.length > 0
                ? `${historyTitleId}-result-${historySelection}`
                : undefined
            }
          />
          <div
            ref={historyResultsRef}
            id={`${historyTitleId}-results`}
            className={styles.historyResults}
            role="listbox"
            aria-label="Sent messages"
          >
            {filteredHistory.length > 0 ? (
              filteredHistory.map((message, index) => (
                <button
                  type="button"
                  className={`${styles.historyResult} ${index === historySelection ? styles.historyResultSelected : ""}`}
                  id={`${historyTitleId}-result-${index}`}
                  key={`${index}-${message}`}
                  role="option"
                  aria-selected={index === historySelection}
                  onMouseEnter={() => setHistorySelection(index)}
                  onClick={() => selectHistoryMessage(message)}
                >
                  {message}
                </button>
              ))
            ) : (
              <p className={styles.historyEmpty}>
                {sentHistory.length === 0
                  ? "No sent messages in this chat yet."
                  : "No sent messages match that search."}
              </p>
            )}
          </div>
          <p className={styles.historyHint}>
            ↑↓ choose · Enter restore · Esc cancel
          </p>
        </div>
      </dialog>
    </section>
  );
}
