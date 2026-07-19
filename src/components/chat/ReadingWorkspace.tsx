"use client";

import type { ReactNode } from "react";
import { useId, useState, useSyncExternalStore } from "react";
import styles from "./ReadingWorkspace.module.css";

interface ReadingWorkspaceProps {
  main: ReactNode;
  chat: ReactNode;
  mainLabel: string;
}

const CHAT_VISIBILITY_KEY = "papernook:reading-chat-visible";
const CHAT_VISIBILITY_EVENT = "papernook:reading-chat-changed";

function subscribe(onStoreChange: () => void): () => void {
  window.addEventListener("storage", onStoreChange);
  window.addEventListener(CHAT_VISIBILITY_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(CHAT_VISIBILITY_EVENT, onStoreChange);
  };
}

function chatIsVisible(): boolean {
  return window.localStorage.getItem(CHAT_VISIBILITY_KEY) !== "hidden";
}

function subscribeToCompact(onStoreChange: () => void): () => void {
  const query = window.matchMedia("(max-width: 900px)");
  query.addEventListener("change", onStoreChange);
  return () => query.removeEventListener("change", onStoreChange);
}

function compactReadingWorkspace(): boolean {
  return window.matchMedia("(max-width: 900px)").matches;
}

export function ReadingWorkspace({
  main,
  chat,
  mainLabel,
}: ReadingWorkspaceProps) {
  const chatVisible = useSyncExternalStore(
    subscribe,
    chatIsVisible,
    () => true,
  );
  const compact = useSyncExternalStore(
    subscribeToCompact,
    compactReadingWorkspace,
    () => false,
  );
  const [compactTab, setCompactTab] = useState<"reading" | "chat">("reading");
  const baseId = useId();
  const readingTabId = `${baseId}-reading-tab`;
  const chatTabId = `${baseId}-chat-tab`;
  const readingPanelId = `${baseId}-reading-panel`;
  const chatPanelId = `${baseId}-chat-panel`;

  function toggleChat(): void {
    window.localStorage.setItem(
      CHAT_VISIBILITY_KEY,
      chatVisible ? "hidden" : "visible",
    );
    window.dispatchEvent(new Event(CHAT_VISIBILITY_EVENT));
  }

  function selectAdjacentTab(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = compactTab === "reading" ? "chat" : "reading";
    setCompactTab(next);
    document
      .getElementById(next === "reading" ? readingTabId : chatTabId)
      ?.focus();
  }

  return (
    <div
      className={`${styles.root} ${chatVisible ? "" : styles.focusMode}`}
      data-chat-visible={chatVisible}
      data-compact-tab={compactTab}
    >
      <div
        className={styles.mobileTabs}
        role="tablist"
        aria-label="Paper workspace"
        onKeyDown={selectAdjacentTab}
      >
        <button
          id={readingTabId}
          type="button"
          role="tab"
          aria-selected={compactTab === "reading"}
          aria-controls={readingPanelId}
          tabIndex={compactTab === "reading" ? 0 : -1}
          onClick={() => setCompactTab("reading")}
        >
          Reading
        </button>
        <button
          id={chatTabId}
          type="button"
          role="tab"
          aria-selected={compactTab === "chat"}
          aria-controls={chatPanelId}
          tabIndex={compactTab === "chat" ? 0 : -1}
          onClick={() => setCompactTab("chat")}
        >
          Chat
        </button>
      </div>
      <section
        id={readingPanelId}
        className={styles.main}
        aria-label={mainLabel}
        role={compact ? "tabpanel" : undefined}
        aria-labelledby={compact ? readingTabId : undefined}
      >
        {main}
      </section>
      <aside
        id={chatPanelId}
        className={`${styles.chat} ${chatVisible ? "" : styles.desktopChatHidden}`}
        role={compact ? "tabpanel" : undefined}
        aria-labelledby={compact ? chatTabId : undefined}
      >
        {chat}
      </aside>
      <button
        type="button"
        className={styles.toggle}
        onClick={toggleChat}
        aria-expanded={chatVisible}
        aria-controls={chatPanelId}
      >
        <span aria-hidden="true">{chatVisible ? "→" : "←"}</span>
        {chatVisible ? "Focus reading" : "Show chat"}
      </button>
    </div>
  );
}
