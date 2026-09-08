"use client";

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { Pencil, Trash2 } from "lucide-react";
import {
  BIBLIOGRAPHY_EVENT,
  CHAT_PROMPT_EVENT,
  PAPER_REF_EVENT,
  detailFromDataset,
  parseChatPromptEvent,
  type ChatPromptDetail,
  type PaperRefAction,
} from "@/lib/chat/paper-ref-events";
import {
  matchCitation,
  type BibEntry,
  type Bibliography,
} from "@/lib/pdf/bibliography";
import { ChatMessages, type ChatMessage } from "./ChatMessages";
import { CitationPopover } from "./CitationPopover";
import { HistorySearchDialog, useComposerHistory } from "./ComposerHistory";
import styles from "./ChatPanel.module.css";
import { useConnection } from "@/components/offline/useConnection";

interface ChatHeader {
  id: string;
  title: string;
  createdAt: string;
}

interface ChatPanelProps {
  topic: string;
  slug: string;
  currentOrigin: string;
  paperSourceUrl?: string;
  /** Server-computed hasConfiguredProvider(); false renders a setup hint. */
  aiAvailable: boolean;
  /** Provider capabilities.vision; false disables image attachments. */
  visionAvailable: boolean;
  /** The page mounts an editable PdfReader that saves answers as notes. */
  marginNotes?: boolean;
  /**
   * GET-able server-side bibliography cache for this paper
   * (`/api/v1/papers/<topic>/<slug>/bibliography`): seeds citation
   * decorations before — or without — a PdfReader scan. A later
   * BIBLIOGRAPHY_EVENT always overrides (fresher scan).
   */
  bibliographyEndpoint?: string;
  /**
   * A PdfReader listens to PAPER_REF_EVENT on this page. Without one,
   * in-paper refs stay undecorated and citation activations open a local
   * CitationPopover instead of dispatching into the void.
   */
  hasReader?: boolean;
}

const ACTIVE_CHAT_STORAGE_PREFIX = "papernook:active-chat";

const REGENERATE_THREE_PROMPT =
  "Regenerate the failed interactive 3D visualization from this answer. Preserve its explanatory intent, but produce a fresh threejs block using the provided global THREE and OrbitControls variables without import declarations.";

function activeChatStorageKey(topic: string, slug: string): string {
  return `${ACTIVE_CHAT_STORAGE_PREFIX}:${topic}:${slug}`;
}

function readActiveChat(topic: string, slug: string): string | null {
  try {
    return window.localStorage.getItem(activeChatStorageKey(topic, slug));
  } catch {
    return null;
  }
}

function saveActiveChat(topic: string, slug: string, chatId: string): void {
  try {
    window.localStorage.setItem(activeChatStorageKey(topic, slug), chatId);
  } catch {
    // Chat remains usable when browser storage is unavailable.
  }
}

function clearActiveChat(topic: string, slug: string): void {
  try {
    window.localStorage.removeItem(activeChatStorageKey(topic, slug));
  } catch {
    // Chat remains usable when browser storage is unavailable.
  }
}

export function ChatPanel({
  topic,
  slug,
  currentOrigin,
  paperSourceUrl,
  aiAvailable,
  visionAvailable,
  marginNotes = false,
  bibliographyEndpoint,
  hasReader = false,
}: ChatPanelProps) {
  const connected = useConnection();
  const base = `/api/v1/papers/${topic}/${slug}`;
  const [chats, setChats] = useState<ChatHeader[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [pastedImages, setPastedImages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [deletingChat, setDeletingChat] = useState(false);
  const [renamingChat, setRenamingChat] = useState(false);
  const [vanishing, setVanishing] = useState<ReadonlySet<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [bibliography, setBibliography] = useState<Bibliography | null>(null);
  const [citationPopover, setCitationPopover] = useState<{
    entry: BibEntry;
    anchor: { top: number; bottom: number; left: number; right: number };
  } | null>(null);
  const bibliographyFromEventRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const historyDialogRef = useRef<HTMLDialogElement>(null);
  const historySearchRef = useRef<HTMLInputElement>(null);
  const historyResultsRef = useRef<HTMLDivElement>(null);
  const history = useComposerHistory({
    messages,
    input,
    setInput,
    inputRef,
    dialogRef: historyDialogRef,
    searchRef: historySearchRef,
    resultsRef: historyResultsRef,
  });
  const refHoverTimerRef = useRef<number | null>(null);
  const openRequestRef = useRef(0);
  const applyPromptRef = useRef<(detail: ChatPromptDetail) => void>(() => {});

  useEffect(() => {
    void fetch(`${base}/chats`, { credentials: "include" })
      .then((r) => r.json())
      .then((d: { chats?: ChatHeader[] }) => {
        const nextChats = d.chats ?? [];
        const savedChatId = readActiveChat(topic, slug);
        const initialChat =
          nextChats.find((chat) => chat.id === savedChatId) ?? nextChats[0];
        setChats(nextChats);
        if (initialChat) void openChat(initialChat.id);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic, slug]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

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
      if (isBibliographyShaped(detail)) {
        bibliographyFromEventRef.current = true;
        setBibliography(detail);
      }
    };
    window.addEventListener(BIBLIOGRAPHY_EVENT, onBibliography);
    return () => {
      window.removeEventListener(BIBLIOGRAPHY_EVENT, onBibliography);
      clearRefHover();
    };
  }, []);

  // Seed citation decorations from the server-side cache: on the canvas no
  // reader ever scans, and on the paper page the scan lands seconds after
  // mount. A scan that already arrived — or arrives later — wins.
  useEffect(() => {
    if (!bibliographyEndpoint) return;
    const controller = new AbortController();
    void fetch(bibliographyEndpoint, {
      credentials: "include",
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: unknown) => {
        const cached =
          data && typeof data === "object" && "bibliography" in data
            ? (data as { bibliography: unknown }).bibliography
            : null;
        if (isBibliographyShaped(cached) && !bibliographyFromEventRef.current) {
          setBibliography((current) => current ?? cached);
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [bibliographyEndpoint]);

  // Other surfaces (a reference popover, a text selection) hand the composer
  // a prompt. The handler closes over the current send(), so it is refreshed
  // every render while the window listener itself is registered once.
  useEffect(() => {
    applyPromptRef.current = (detail) => {
      if (detail.send && aiAvailable && !busy) {
        void send(detail.text);
        return;
      }
      setInput(detail.text);
      history.resetNavigation();
      // ReadingWorkspace reveals the chat in the same dispatch; React
      // commits that after this handler returns, and focus() on a
      // display:none textarea is a no-op — so focus one frame later.
      window.requestAnimationFrame(() => inputRef.current?.focus());
    };
  });

  useEffect(() => {
    const onPrompt = (event: Event) => {
      const detail = parseChatPromptEvent(
        (event as CustomEvent<unknown>).detail,
      );
      if (detail) applyPromptRef.current(detail);
    };
    window.addEventListener(CHAT_PROMPT_EVENT, onPrompt);
    return () => window.removeEventListener(CHAT_PROMPT_EVENT, onPrompt);
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
    // No PdfReader is listening on this page: answer citations locally with
    // an anchored popover instead of dispatching into the void. Click-only:
    // the popover is a focus-taking dialog, and opening it from the hover
    // dwell would steal the caret from the composer mid-sentence.
    if (!hasReader && "citation" in detail) {
      if (action === "preview") return false;
      if (!bibliography) return false;
      const entry = matchCitation(bibliography, detail.citation);
      if (!entry) return false;
      const rect = button.getBoundingClientRect();
      setCitationPopover({
        entry,
        anchor: {
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
        },
      });
      return true;
    }
    window.dispatchEvent(new CustomEvent(PAPER_REF_EVENT, { detail }));
    return true;
  }

  // Same interaction grammar as the PDF's own citation hotspots: mouse
  // dwell (180ms) previews, click commits — navigation for in-paper refs,
  // preview for citations (their click IS the preview, matching the PDF).
  // Without a reader the dwell is inert; see the dispatchRef diversion.
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

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (history.onComposerKeyDown(event)) {
      event.preventDefault();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  async function openChat(id: string): Promise<void> {
    const request = ++openRequestRef.current;
    history.reset();
    saveActiveChat(topic, slug, id);
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
          history.reset();
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
      history.reset();
      setChats((c) => [data.chat as ChatHeader, ...c]);
      saveActiveChat(topic, slug, data.chat.id);
      setActiveId(data.chat.id);
      setMessages([]);
      return data.chat.id;
    }
    return null;
  }

  async function deleteCurrentChat(): Promise<void> {
    const chatId = activeId;
    const chatIndex = chats.findIndex((chat) => chat.id === chatId);
    const chat = chats[chatIndex];
    if (!chatId || !chat || busy || deletingChat) return;
    if (
      !window.confirm(
        `Delete “${chat.title}”? This permanently deletes the conversation and its attached images.`,
      )
    ) {
      return;
    }

    setDeletingChat(true);
    setError(null);
    try {
      const response = await fetch(`${base}/chats/${chatId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ entire: true }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? "Could not delete the conversation.");
      }

      ++openRequestRef.current;
      const remaining = chats.filter((candidate) => candidate.id !== chatId);
      const nextChat = remaining[Math.min(chatIndex, remaining.length - 1)];
      setChats(remaining);
      setActiveId(null);
      setMessages([]);
      setInput("");
      setPastedImages([]);
      setVanishing(new Set());
      history.reset();
      if (nextChat) {
        await openChat(nextChat.id);
      } else {
        clearActiveChat(topic, slug);
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not delete the conversation.",
      );
    } finally {
      setDeletingChat(false);
    }
  }

  async function renameCurrentChat(): Promise<void> {
    const chatId = activeId;
    const chat = chats.find((candidate) => candidate.id === chatId);
    if (!chatId || !chat || deletingChat || renamingChat) return;
    const title = window.prompt("Rename conversation", chat.title);
    if (title === null) return;

    setRenamingChat(true);
    setError(null);
    try {
      const response = await fetch(`${base}/chats/${chatId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ title }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        chat?: ChatHeader;
        error?: string;
      };
      if (!response.ok || !payload.chat) {
        throw new Error(payload.error ?? "Could not rename the conversation.");
      }
      const renamed = payload.chat;
      setChats((current) =>
        current.map((candidate) =>
          candidate.id === renamed.id ? renamed : candidate,
        ),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not rename the conversation.",
      );
    } finally {
      setRenamingChat(false);
    }
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

  async function send(forcedContent?: string): Promise<void> {
    if (!connected) {
      setError("Connect to continue this conversation.");
      return;
    }
    const content = (forcedContent ?? input).trim();
    if (!content || busy) return;
    let chatId = activeId;
    if (!chatId) {
      chatId = await newChat();
      if (!chatId) return;
    }
    setBusy(true);
    setError(null);
    setInput("");
    history.reset();
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
          disabled={deletingChat}
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
          className={styles.renameChatBtn}
          disabled={!activeId || deletingChat || renamingChat}
          onClick={() => void renameCurrentChat()}
          aria-label="Rename conversation"
          title="Rename conversation"
        >
          <Pencil size={18} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={styles.deleteChatBtn}
          disabled={!activeId || busy || deletingChat}
          onClick={() => void deleteCurrentChat()}
          aria-label="Delete conversation"
          title="Delete conversation"
        >
          <Trash2 size={18} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={styles.newBtn}
          disabled={!aiAvailable || deletingChat}
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
        <ChatMessages
          messages={messages}
          busy={busy}
          vanishing={vanishing}
          bibliography={bibliography}
          paperRefs={hasReader}
          currentOrigin={currentOrigin}
          paperSourceUrl={paperSourceUrl}
          visionAvailable={visionAvailable}
          marginNotes={marginNotes}
          onDelete={deleteMsg}
          onRegenerateThree={() => void send(REGENERATE_THREE_PROMPT)}
        />
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
              history.resetNavigation();
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
            disabled={busy || !connected || input.trim().length === 0}
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

      {citationPopover && (
        <CitationPopover
          entry={citationPopover.entry}
          anchor={citationPopover.anchor}
          chatPrompts={aiAvailable}
          onClose={() => setCitationPopover(null)}
        />
      )}

      <HistorySearchDialog
        history={history}
        dialogRef={historyDialogRef}
        searchRef={historySearchRef}
        resultsRef={historyResultsRef}
      />
    </section>
  );
}

function isBibliographyShaped(value: unknown): value is Bibliography {
  return (
    typeof value === "object" &&
    value !== null &&
    "style" in value &&
    "entries" in value &&
    Array.isArray((value as { entries: unknown }).entries)
  );
}
