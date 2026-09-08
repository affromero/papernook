"use client";
import { useState, type FormEvent } from "react";
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
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const fields = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/v1/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim() || undefined,
          content: content || undefined,
          format,
          title: String(fields.get("title") || "").trim() || undefined,
          topic: fields.get("topic"),
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
      <label>
        Public ChatGPT or Claude share link
        <input
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://chatgpt.com/share/..."
        />
      </label>
      <p>
        Or paste a transcript or choose an exported file. Missing attachments
        are not imported.
      </p>
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
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            if (file.size > 4 * 1024 * 1024) {
              setError("Transcript exceeds the 4 MB limit.");
              return;
            }
            void file
              .text()
              .then((text) => {
                setContent(text);
                setUrl("");
                setFormat(/\.jsonl?$/.test(file.name) ? "json" : "markdown");
              })
              .catch(() => setError("Could not read the selected file."));
          }}
        />
      </label>
      <label>
        Transcript
        <textarea
          value={content}
          onChange={(event) => setContent(event.target.value)}
        />
      </label>
      <label>
        Title (optional)
        <input name="title" maxLength={200} />
      </label>
      <label>
        Topic
        <input
          name="topic"
          defaultValue="Uncategorized"
          required
          maxLength={80}
        />
      </label>
      <label>
        Tags, separated by commas
        <input name="tags" />
      </label>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <button disabled={busy}>
        {busy ? "Importing…" : "Import conversation"}
      </button>
    </form>
  );
}
