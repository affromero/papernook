"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { Markdown } from "@/components/chat/Markdown";
import type { PublishedThread } from "@/lib/sharing/schema";
import styles from "./SharingControls.module.css";

interface Participant {
  id: string;
  requestedName: string;
  name: string;
  status: "pending" | "approved" | "revoked";
}
interface Collaboration {
  connected: boolean;
  status: string;
  participantId?: string;
  ownActorId?: string;
  mirrorConflict?: boolean;
  syncErrors?: string[];
  shares: { id: string; createdAt: string }[];
  threads: (PublishedThread & { shareId?: string })[];
}

function threadKey(thread: PublishedThread & { shareId?: string }): string {
  return `${thread.shareId ?? "connected"}-${thread.actorId}-${thread.id}`;
}

async function responseJson<Result>(response: Response): Promise<Result> {
  const data: unknown = await response.json();
  if (!response.ok)
    throw new Error(
      data &&
        typeof data === "object" &&
        "error" in data &&
        typeof data.error === "string"
        ? data.error
        : "The sharing request failed.",
    );
  return data as Result;
}

export function Participants({ endpoint }: { endpoint: string }) {
  const [participants, setParticipants] = useState<Participant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function load() {
    setError(null);
    try {
      setParticipants(
        (
          await responseJson<{ participants: Participant[] }>(
            await fetch(endpoint),
          )
        ).participants,
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not load requests.",
      );
    }
  }
  async function update(
    participant: Participant,
    status: "approved" | "revoked",
  ) {
    const message =
      status === "approved"
        ? `Approve ${participant.requestedName}? First verify code ${participant.id} with them. They will be able to annotate this paper and publish conversations.`
        : `Revoke ${participant.name}'s access? Existing downloaded copies cannot be recalled.`;
    if (!window.confirm(message)) return;
    setBusy(true);
    setError(null);
    try {
      setParticipants(
        (
          await responseJson<{ participants: Participant[] }>(
            await fetch(endpoint, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: participant.id, status }),
            }),
          )
        ).participants,
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not update access.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={styles.participants}>
      <button type="button" onClick={() => void load()}>
        Manage participants
      </button>
      {participants && (
        <>
          <p>
            Check each code with the person requesting access before approving.
          </p>
          {participants.length === 0 && <p>No access requests.</p>}
          {participants.map((participant) => (
            <div className={styles.participant} key={participant.id}>
              <span>
                <strong>{participant.name}</strong>
                <small>
                  {participant.status} · <code>{participant.id}</code>
                </small>
              </span>
              {participant.status === "pending" && (
                <button
                  disabled={busy}
                  type="button"
                  onClick={() => void update(participant, "approved")}
                >
                  Approve
                </button>
              )}
              {participant.status !== "revoked" && (
                <button
                  disabled={busy}
                  type="button"
                  onClick={() => void update(participant, "revoked")}
                >
                  Revoke
                </button>
              )}
            </div>
          ))}
        </>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </div>
  );
}

export function CollaborationPanel({
  topic,
  slug,
  connected,
}: {
  topic: string;
  slug: string;
  connected: boolean;
}) {
  const base = `/api/v1/papers/${topic}/${slug}`;
  const [data, setData] = useState<Collaboration | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [chats, setChats] = useState<{ id: string; title: string }[]>([]);
  const [chatId, setChatId] = useState("");
  const [shareId, setShareId] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const next = await responseJson<Collaboration>(
        await fetch(`${base}/collaboration`),
      );
      setData(next);
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not refresh collaboration.",
      );
    }
  }, [base]);
  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const interval = window.setInterval(() => void load(), 30_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [load]);
  async function loadChats() {
    try {
      setChats(
        (
          await responseJson<{ chats: { id: string; title: string }[] }>(
            await fetch(`${base}/chats`),
          )
        ).chats,
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not load conversations.",
      );
    }
  }
  async function publish() {
    setBusy(true);
    setError(null);
    try {
      await responseJson(
        await fetch(`${base}/collaboration`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chatId,
            ...(data?.connected
              ? {}
              : { shareId: shareId || data?.shares[0]?.id }),
          }),
        }),
      );
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not publish the conversation.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    setBusy(true);
    try {
      if (data?.status !== "pending")
        await responseJson<unknown>(
          await fetch(`${base}/collaboration`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "sync" }),
          }),
        );
      await load();
      await loadChats();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not sync this reading.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (!connected && !data?.shares.length && !error) return null;
  async function unpublish(
    thread: Pick<PublishedThread, "id"> & { shareId?: string },
  ) {
    if (
      !window.confirm(
        "Stop sharing this conversation? Previously downloaded copies cannot be recalled.",
      )
    )
      return;
    setBusy(true);
    try {
      await responseJson<unknown>(
        await fetch(`${base}/collaboration`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "unpublish",
            chatId: thread.id,
            ...(thread.shareId ? { shareId: thread.shareId } : {}),
          }),
        }),
      );
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not withdraw the conversation.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function detach() {
    if (
      !window.confirm(
        "Keep an independent local copy and stop syncing? Your cached PDF and personal chats will remain. Published copies held by others cannot be recalled.",
      )
    )
      return;
    setBusy(true);
    try {
      const result = await responseJson<{ warning: string | null }>(
        await fetch(`${base}/collaboration`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "disconnect" }),
        }),
      );
      if (result.warning) window.alert(result.warning);
      window.location.reload();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not detach this copy.",
      );
      setBusy(false);
    }
  }
  return (
    <details className={styles.collaboration} open={connected}>
      <summary>
        Collaboration {data?.status === "pending" ? "· awaiting approval" : ""}
      </summary>
      <div className={styles.body}>
        {data?.syncErrors?.map((message, index) => (
          <p key={index} role="alert" className={styles.error}>
            {message}
          </p>
        ))}
        {data?.mirrorConflict && (
          <p role="alert" className={styles.error}>
            The local PDF has changes from outside collaboration. They have been
            preserved and will not be uploaded. Keep an independent copy to work
            with them.
          </p>
        )}
        {data?.participantId && (
          <p>
            Your verification code: <code>{data.participantId}</code>. Give this
            code to the owner before they approve access.
          </p>
        )}
        <p>
          Annotations are shared with every participant and anyone holding an
          existing reading link. Chats stay private until you publish them.
          Published chats include future turns.
        </p>
        {connected && (
          <p>
            Browser edits use your approved identity. Canvas and exercises sync
            with this reading. The WebDAV PDFs are reading mirrors.
          </p>
        )}
        <button type="button" disabled={busy} onClick={() => void refresh()}>
          Refresh sharing
        </button>
        {data && data.status !== "pending" && (
          <div className={styles.publish}>
            <label>
              Publish a conversation
              <select
                value={chatId}
                onFocus={() => void loadChats()}
                onChange={(event) => setChatId(event.target.value)}
              >
                <option value="">Choose one of your chats</option>
                {chats.map((chat) => (
                  <option value={chat.id} key={chat.id}>
                    {chat.title}
                  </option>
                ))}
              </select>
            </label>
            {(data?.shares.length ?? 0) > 1 && (
              <label>
                Collaboration
                <select
                  value={shareId}
                  onChange={(event) => setShareId(event.target.value)}
                >
                  {data?.shares.map((share) => (
                    <option value={share.id} key={share.id}>
                      {new Date(share.createdAt).toLocaleString()}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button
              disabled={!chatId || busy}
              type="button"
              onClick={() => void publish()}
            >
              {busy ? "Publishing…" : "Publish and sync"}
            </button>
            <button
              disabled={!chatId || busy}
              type="button"
              onClick={() =>
                void unpublish({
                  id: chatId,
                  ...(shareId || data.shares[0]?.id
                    ? { shareId: shareId || data.shares[0]?.id }
                    : {}),
                })
              }
            >
              Stop sharing selected conversation
            </button>
          </div>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        {connected && (
          <button disabled={busy} type="button" onClick={() => void detach()}>
            Keep an independent copy
          </button>
        )}
        {data?.threads.map((thread) => (
          <details
            className={styles.thread}
            key={threadKey(thread)}
            onToggle={(event) => {
              const open = event.currentTarget.open;
              setExpanded((current) => {
                const next = new Set(current);
                if (open) next.add(threadKey(thread));
                else next.delete(threadKey(thread));
                return next;
              });
            }}
          >
            <summary>
              {thread.chat.header.title}
              <small>
                {thread.author} · {thread.actorId}
              </small>
            </summary>
            {thread.actorId === data.ownActorId && (
              <button
                disabled={busy}
                type="button"
                onClick={() => void unpublish(thread)}
              >
                Stop sharing conversation
              </button>
            )}
            {expanded.has(threadKey(thread)) &&
              thread.chat.messages.map((message, index) => (
                <article key={index}>
                  <strong>
                    {message.role === "user"
                      ? thread.author
                      : `AI · ${thread.author}`}
                  </strong>
                  <Markdown
                    content={message.content}
                    renderThree={false}
                    decorateRefs={false}
                    paperRefs={false}
                  />
                  {message.images?.map((image) => {
                    const name = image.slice(6);
                    const content = thread.assets[name];
                    const extension = name.split(".").at(-1);
                    return content ? (
                      <Image
                        width={1200}
                        height={900}
                        unoptimized
                        key={name}
                        src={`data:image/${extension === "jpg" ? "jpeg" : extension};base64,${content}`}
                        alt="Shared conversation attachment"
                      />
                    ) : null;
                  })}
                </article>
              ))}
          </details>
        ))}
      </div>
    </details>
  );
}
