"use client";

import type { ReactNode } from "react";
import { useId, useState, useSyncExternalStore } from "react";
import styles from "./ReadingWorkspace.module.css";

interface ReadingWorkspaceProps {
  main: ReactNode;
  chat: ReactNode;
  mainLabel: string;
  /** Page chrome (title, breadcrumbs) the header toggle can hide. */
  header?: ReactNode;
}

const CHAT_VISIBILITY_KEY = "papernook:reading-chat-visible";
const CHAT_VISIBILITY_EVENT = "papernook:reading-chat-changed";
const HEADER_VISIBILITY_KEY = "papernook:reading-header-visible";
const HEADER_VISIBILITY_EVENT = "papernook:reading-header-changed";

function subscribeTo(event: string) {
  return (onStoreChange: () => void): (() => void) => {
    window.addEventListener("storage", onStoreChange);
    window.addEventListener(event, onStoreChange);
    return () => {
      window.removeEventListener("storage", onStoreChange);
      window.removeEventListener(event, onStoreChange);
    };
  };
}

const subscribe = subscribeTo(CHAT_VISIBILITY_EVENT);
const subscribeHeader = subscribeTo(HEADER_VISIBILITY_EVENT);

function chatIsVisible(): boolean {
  return window.localStorage.getItem(CHAT_VISIBILITY_KEY) !== "hidden";
}

function headerIsVisible(): boolean {
  return window.localStorage.getItem(HEADER_VISIBILITY_KEY) !== "hidden";
}

function setVisibility(key: string, event: string, visible: boolean): void {
  window.localStorage.setItem(key, visible ? "visible" : "hidden");
  window.dispatchEvent(new Event(event));
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
  header,
}: ReadingWorkspaceProps) {
  const chatVisible = useSyncExternalStore(
    subscribe,
    chatIsVisible,
    () => true,
  );
  const headerVisible = useSyncExternalStore(
    subscribeHeader,
    headerIsVisible,
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
    if (chatVisible) {
      // Focus reading is the everything-off mode: text only.
      setVisibility(CHAT_VISIBILITY_KEY, CHAT_VISIBILITY_EVENT, false);
      setVisibility(HEADER_VISIBILITY_KEY, HEADER_VISIBILITY_EVENT, false);
      return;
    }
    setVisibility(CHAT_VISIBILITY_KEY, CHAT_VISIBILITY_EVENT, true);
  }

  function toggleHeader(): void {
    setVisibility(
      HEADER_VISIBILITY_KEY,
      HEADER_VISIBILITY_EVENT,
      !headerVisible,
    );
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
    <>
      {header && headerVisible && header}
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
        <div className={styles.toggleRow}>
          {header && (
            <button
              type="button"
              className={styles.toggle}
              onClick={toggleHeader}
              aria-expanded={headerVisible}
            >
              <span aria-hidden="true">{headerVisible ? "↑" : "↓"}</span>
              {headerVisible ? "Hide header" : "Show header"}
            </button>
          )}
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
      </div>
    </>
  );
}
