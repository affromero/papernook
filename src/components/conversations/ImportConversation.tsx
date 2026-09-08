"use client";
import { useState, type ChangeEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import styles from "./ConversationView.module.css";
export function ImportConversation({
  initialUrl = "",
}: {
  initialUrl?: string;
}) {
  const router = useRouter();
  const [url, setUrl] = useState(initialUrl);
  const [content, setContent] = useState("");
  const [format, setFormat] = useState("markdown");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<"link" | "transcript">("link");
  const [reading, setReading] = useState(false);
  const ready = Boolean(source === "link" ? url.trim() : content.trim());

  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    setError("");
    if (file.size > 4 * 1024 * 1024) {
      setError("Transcript exceeds the 4 MB limit.");
      event.currentTarget.value = "";
      return;
    }
    setReading(true);
    try {
      setContent(await file.text());
      setFormat(/\.jsonl?$/i.test(file.name) ? "json" : "markdown");
    } catch {
      setError("Could not read the selected file.");
    } finally {
      setReading(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || busy || reading) return;
    setBusy(true);
    setError("");
    const fields = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/v1/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: source === "link" ? url.trim() : undefined,
          content: source === "transcript" ? content : undefined,
          format,
          title: String(fields.get("title") || "").trim() || undefined,
          topic: String(fields.get("topic") || "").trim() || "Uncategorized",
          tags: String(fields.get("tags") || "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Import failed.");
      router.push(`/conversations/${result.conversation.id}`);
      router.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className={styles.form} onSubmit={(event) => void submit(event)}>
      <h2>Import a conversation</h2>
      <fieldset className={styles.importFields} disabled={busy || reading}>
        <div
          className={styles.sourceSwitch}
          role="group"
          aria-label="Import source"
        >
          <button
            type="button"
            aria-pressed={source === "link"}
            onClick={() => {
              setSource("link");
              setError("");
            }}
          >
            Share link
          </button>
          <button
            type="button"
            aria-pressed={source === "transcript"}
            onClick={() => {
              setSource("transcript");
              setError("");
            }}
          >
            Paste or upload
          </button>
        </div>
        {source === "link" ? (
          <>
            <label>
              Public ChatGPT or Claude share link
              <input
                type="url"
                required
                maxLength={2000}
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://chatgpt.com/share/..."
              />
            </label>
            <p className={styles.hint}>
              Paste a public ChatGPT or Claude conversation link.
            </p>
          </>
        ) : (
          <>
            <label>
              Transcript format
              <select
                value={format}
                onChange={(event) => setFormat(event.target.value)}
              >
                <option value="markdown">Markdown or text</option>
                <option value="json">JSON messages</option>
              </select>
            </label>
            <label>
              Transcript file
              <input
                type="file"
                accept=".json,.jsonl,.md,.txt,.markdown"
                onChange={(event) => void readFile(event)}
              />
            </label>
            <label>
              Transcript
              <textarea
                value={content}
                required
                placeholder={"# User\nYour question\n\n# Assistant\nThe reply"}
                onChange={(event) => setContent(event.target.value)}
              />
            </label>
            <p className={styles.hint}>
              Upload a text, Markdown, or JSON file up to 4 MB, or paste the
              conversation above.
            </p>
          </>
        )}
        <details className={styles.metadata}>
          <summary>
            Title, topic, and tags <span>(optional)</span>
          </summary>
          <div className={styles.importFields}>
            <label>
              Title (optional)
              <input name="title" maxLength={200} />
            </label>
            <label>
              Topic
              <input name="topic" defaultValue="Uncategorized" maxLength={80} />
            </label>
            <label>
              Tags, separated by commas
              <input name="tags" />
            </label>
          </div>
        </details>
      </fieldset>
      <p className={styles.hint}>
        Only this profile can see imported conversations. Missing attachments
        are not imported.
      </p>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <button
        type="submit"
        className={styles.primaryButton}
        disabled={!ready || busy || reading}
      >
        {busy
          ? "Importing…"
          : reading
            ? "Reading file…"
            : "Import conversation"}
      </button>
      <p className={styles.hint} role="status">
        {busy
          ? "Importing your conversation. This may take a moment."
          : reading
            ? "Reading your transcript."
            : !ready
              ? source === "link"
                ? "Add a share link to enable import."
                : "Paste a transcript or choose a file to enable import."
              : "Ready to import."}
      </p>
    </form>
  );
}
