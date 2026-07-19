"use client";

import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
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

  function toggleChat(): void {
    window.localStorage.setItem(
      CHAT_VISIBILITY_KEY,
      chatVisible ? "hidden" : "visible",
    );
    window.dispatchEvent(new Event(CHAT_VISIBILITY_EVENT));
  }

  return (
    <div
      className={`${styles.root} ${chatVisible ? "" : styles.focusMode}`}
      data-chat-visible={chatVisible}
    >
      <section className={styles.main} aria-label={mainLabel}>
        {main}
      </section>
      {chatVisible && <aside className={styles.chat}>{chat}</aside>}
      <button
        type="button"
        className={styles.toggle}
        onClick={toggleChat}
        aria-expanded={chatVisible}
        aria-controls="paper-chat-panel"
      >
        <span aria-hidden="true">{chatVisible ? "→" : "←"}</span>
        {chatVisible ? "Focus reading" : "Show chat"}
      </button>
    </div>
  );
}
