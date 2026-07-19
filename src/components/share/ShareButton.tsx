"use client";

import { useRef, useState } from "react";
import styles from "./ShareButton.module.css";

interface ChatHeader {
  id: string;
  title: string;
  createdAt: string;
}

interface ShareSummary {
  id: string;
  href: string;
  createdAt: string;
  conversations: { id: string; title: string }[];
}

interface ShareButtonProps {
  topic: string;
  slug: string;
}

export function ShareButton({ topic, slug }: ShareButtonProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const base = `/api/v1/papers/${topic}/${slug}`;
  const [chats, setChats] = useState<ChatHeader[]>([]);
  const [shares, setShares] = useState<ShareSummary[]>([]);
  const [includeChats, setIncludeChats] = useState(false);
  const [selectedChatIds, setSelectedChatIds] = useState<Set<string>>(
    new Set(),
  );
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function openDialog(): Promise<void> {
    dialogRef.current?.showModal();
    setLoading(true);
    setError(null);
    try {
      const [chatResponse, shareResponse] = await Promise.all([
        fetch(`${base}/chats`, { credentials: "include" }),
        fetch(`${base}/shares`, { credentials: "include" }),
      ]);
      if (!chatResponse.ok || !shareResponse.ok) {
        throw new Error("Could not load sharing options.");
      }
      const chatData = (await chatResponse.json()) as { chats?: ChatHeader[] };
      const shareData = (await shareResponse.json()) as {
        shares?: ShareSummary[];
      };
      const nextChats = chatData.chats ?? [];
      setChats(nextChats);
      setShares(shareData.shares ?? []);
      setIncludeChats(false);
      setSelectedChatIds(new Set(nextChats.map((chat) => chat.id)));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not load sharing options.",
      );
    } finally {
      setLoading(false);
    }
  }

  function toggleChat(chatId: string): void {
    setSelectedChatIds((current) => {
      const next = new Set(current);
      if (next.has(chatId)) next.delete(chatId);
      else next.add(chatId);
      return next;
    });
  }

  async function copyShare(share: ShareSummary): Promise<void> {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}${share.href}`,
      );
      setCopiedId(share.id);
      window.setTimeout(() => setCopiedId(null), 1800);
    } catch {
      setError("Copy failed. Open the link and copy it from the address bar.");
    }
  }

  async function create(): Promise<void> {
    setCreating(true);
    setError(null);
    try {
      const response = await fetch(`${base}/shares`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          chatIds: includeChats ? [...selectedChatIds] : [],
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        share?: ShareSummary;
        error?: string;
      };
      if (!response.ok || !data.share) {
        throw new Error(data.error ?? "Could not create the link.");
      }
      setShares((current) => [data.share as ShareSummary, ...current]);
      await copyShare(data.share);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not create the link.",
      );
    } finally {
      setCreating(false);
    }
  }

  async function revoke(share: ShareSummary): Promise<void> {
    if (
      !window.confirm("Revoke this link? Anyone using it will lose access.")
    ) {
      return;
    }
    setError(null);
    const response = await fetch(`${base}/shares/${share.id}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!response.ok) {
      setError("Could not revoke the link.");
      return;
    }
    setShares((current) => current.filter((item) => item.id !== share.id));
  }

  return (
    <>
      <button className={styles.trigger} type="button" onClick={openDialog}>
        Share
      </button>
      <dialog
        className={styles.dialog}
        ref={dialogRef}
        aria-labelledby="share-dialog-title"
      >
        <div className={styles.dialogInner}>
          <header className={styles.header}>
            <div>
              <p className={styles.eyebrow}>Pass the paper on</p>
              <h2 id="share-dialog-title">Create a view-only reading</h2>
            </div>
            <button
              className={styles.close}
              type="button"
              aria-label="Close sharing dialog"
              onClick={() => dialogRef.current?.close()}
            >
              ×
            </button>
          </header>

          {loading ? (
            <p className={styles.loading}>Opening the sharing desk…</p>
          ) : (
            <>
              <section className={styles.permission}>
                <div className={styles.permissionMark} aria-hidden="true">
                  ◇
                </div>
                <div>
                  <strong>View only</strong>
                  <p>
                    The link shows the current annotated PDF. It cannot edit the
                    paper or conversations.
                  </p>
                </div>
              </section>

              <label className={styles.includeRow}>
                <input
                  type="checkbox"
                  checked={includeChats}
                  onChange={(event) => setIncludeChats(event.target.checked)}
                />
                <span>
                  <strong>Include conversation snapshots</strong>
                  <small>
                    Later messages stay private unless you create a new link.
                  </small>
                </span>
              </label>

              {includeChats && (
                <div className={styles.chatList}>
                  {chats.length === 0 ? (
                    <p>No conversations to include yet.</p>
                  ) : (
                    chats.map((chat) => (
                      <label className={styles.chatRow} key={chat.id}>
                        <input
                          type="checkbox"
                          checked={selectedChatIds.has(chat.id)}
                          onChange={() => toggleChat(chat.id)}
                        />
                        <span>
                          <strong>{chat.title}</strong>
                          <small>
                            {new Date(chat.createdAt).toLocaleDateString()}
                          </small>
                        </span>
                      </label>
                    ))
                  )}
                </div>
              )}

              <button
                className={styles.create}
                type="button"
                disabled={
                  creating ||
                  (includeChats &&
                    selectedChatIds.size === 0 &&
                    chats.length > 0)
                }
                onClick={create}
              >
                {creating ? "Creating…" : "Create link & copy"}
              </button>

              {error && (
                <p className={styles.error} role="alert">
                  {error}
                </p>
              )}

              {shares.length > 0 && (
                <section className={styles.activeShares}>
                  <h3>Active links</h3>
                  <ul>
                    {shares.map((share) => (
                      <li key={share.id}>
                        <div>
                          <strong>
                            {share.conversations.length === 0
                              ? "Annotated paper"
                              : `${share.conversations.length} conversation ${
                                  share.conversations.length === 1
                                    ? "snapshot"
                                    : "snapshots"
                                }`}
                          </strong>
                          <small>
                            Created{" "}
                            {new Date(share.createdAt).toLocaleDateString()}
                          </small>
                        </div>
                        <div className={styles.shareActions}>
                          <button
                            type="button"
                            onClick={() => void copyShare(share)}
                          >
                            {copiedId === share.id ? "Copied" : "Copy"}
                          </button>
                          <a href={share.href} target="_blank" rel="noreferrer">
                            Open
                          </a>
                          <button
                            className={styles.revoke}
                            type="button"
                            onClick={() => void revoke(share)}
                          >
                            Revoke
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
      </dialog>
    </>
  );
}
