"use client";

import { useState } from "react";
import Link from "next/link";
import styles from "./ImportReading.module.css";

export function ImportOnInstance({ mode }: { mode: "fork" | "collaborate" }) {
  const [instance, setInstance] = useState("");
  const [error, setError] = useState("");
  function openImport(event: React.FormEvent) {
    event.preventDefault();
    try {
      const origin = new URL(instance);
      if (
        origin.protocol !== "https:" ||
        origin.username ||
        origin.password ||
        origin.search ||
        origin.hash ||
        origin.pathname !== "/"
      )
        throw new Error();
      const target = new URL("/sharing/import", origin);
      const source = new URL(window.location.href);
      source.search = "";
      source.hash = "";
      target.searchParams.set("url", source.toString());
      target.searchParams.set("mode", mode);
      window.location.assign(target.toString());
    } catch {
      setError(
        "Enter your Papernook HTTPS address, for example https://papers.example.org.",
      );
    }
  }
  return (
    <section className={styles.invitation}>
      <h2>Open in your Papernook</h2>
      <p>
        {mode === "fork"
          ? "Keep an independent copy of this reading, including the selected chats. Your changes stay in your library."
          : "Request access to annotate together, or keep an independent copy. The owner must approve collaboration after verifying your code."}
      </p>
      <form onSubmit={openImport}>
        <label>
          Your Papernook address
          <input
            type="url"
            required
            value={instance}
            onChange={(event) => setInstance(event.target.value)}
            placeholder="https://papers.example.org"
          />
        </label>
        <button type="submit">Open import</button>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

export function ImportReading({
  initialUrl,
  initialMode,
  topics,
}: {
  initialUrl: string;
  initialMode: string;
  topics: string[];
}) {
  const [url, setUrl] = useState(initialUrl);
  const [topic, setTopic] = useState(topics[0] ?? "shared");
  const [mode, setMode] = useState(
    initialMode === "collaborate" ? "collaborate" : "fork",
  );
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/v1/shares/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          topic,
          mode,
          acknowledgePublicAnnotations: acknowledged,
        }),
      });
      const data: unknown = await response.json();
      if (
        !response.ok ||
        !data ||
        typeof data !== "object" ||
        !("href" in data) ||
        typeof data.href !== "string"
      )
        throw new Error(
          data &&
            typeof data === "object" &&
            "error" in data &&
            typeof data.error === "string"
            ? data.error
            : "Could not import the shared reading.",
        );
      if (!/^\/paper\/[a-z0-9-]+\/[a-z0-9-]+$/.test(data.href))
        throw new Error("The import returned an invalid destination.");
      window.location.assign(data.href);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not import the shared reading.",
      );
      setBusy(false);
    }
  }
  return (
    <div className={styles.root}>
      <Link href="/">← Library</Link>
      <p className={styles.eyebrow}>A reading from another library</p>
      <h1>Bring the paper with you.</h1>
      <p>Import the annotated PDF and the conversations its owner selected.</p>
      <form onSubmit={(event) => void submit(event)}>
        <label>
          Sharing link
          <input
            type="url"
            required
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://papers.example.org/share/…"
          />
        </label>
        <label>
          Topic
          <input
            required
            pattern={"[a-z0-9][a-z0-9\\-]{0,79}"}
            list="sharing-topics"
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
          />
          <datalist id="sharing-topics">
            {topics.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
        </label>
        <fieldset>
          <legend>How to add it</legend>
          <label className={styles.choice}>
            <input
              type="radio"
              name="import-mode"
              checked={mode === "fork"}
              onChange={() => setMode("fork")}
            />
            <span>
              <strong>Independent fork</strong>
              <small>
                Your edits and new chats stay in your library. Copies keep
                working if the original link is revoked.
              </small>
            </span>
          </label>
          <label className={styles.choice}>
            <input
              type="radio"
              name="import-mode"
              checked={mode === "collaborate"}
              onChange={() => setMode("collaborate")}
            />
            <span>
              <strong>Collaborate</strong>
              <small>
                The owner approves your verification code. PDF annotations sync
                through their server. Chats stay private until published.
              </small>
            </span>
          </label>
        </fieldset>
        {mode === "collaborate" && (
          <label className={styles.choice}>
            <input
              type="checkbox"
              required
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            <span>
              I understand that collaborative annotations also appear through
              the owner’s public reading links. I will verify my code with the
              owner.
            </span>
          </label>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy || (mode === "collaborate" && !acknowledged)}
        >
          {busy
            ? "Importing…"
            : mode === "collaborate"
              ? "Import and request access"
              : "Import independent fork"}
        </button>
      </form>
    </div>
  );
}
