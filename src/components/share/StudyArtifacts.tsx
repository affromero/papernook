"use client";
import { useEffect, useRef, useState } from "react";
import dynamicImport from "next/dynamic";
import { PdfReader } from "@/components/pdf/PdfReader";
import { Markdown } from "@/components/chat/Markdown";
import type { ExerciseRecord } from "@/lib/library/exercises/schema";
import styles from "./StudyArtifacts.module.css";

const SharedCanvas = dynamicImport(
  () => import("./SharedCanvas").then((module) => module.SharedCanvas),
  { ssr: false, loading: () => <p>Opening canvas…</p> },
);

export function PublicStudyArtifacts({
  endpoint,
  licenseKey,
}: {
  endpoint: string;
  licenseKey: string | null;
}) {
  const [value, setValue] = useState<{
    document: unknown;
    exercises: ExerciseRecord[];
    hasPdf: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (!opened) return;
    const controller = new AbortController();
    void fetch(endpoint, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok)
          throw new Error("This shared snapshot is unavailable.");
        setValue(await response.json());
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(
            error instanceof Error
              ? error.message
              : "The snapshot could not be loaded.",
          );
      });
    return () => controller.abort();
  }, [endpoint, opened]);
  return (
    <section className={styles.root} aria-label="Shared canvas and exercises">
      <h2>Canvas and exercises</h2>
      <p>These are the snapshots the owner included when creating this link.</p>
      {!opened && (
        <button type="button" onClick={() => setOpened(true)}>
          View canvas and exercises
        </button>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {opened && !value && !error && (
        <p role="status">Loading shared snapshots…</p>
      )}
      {value?.document ? (
        <SharedCanvas document={value.document} licenseKey={licenseKey} />
      ) : null}
      {value?.exercises.map((record) => (
        <article className={styles.record} key={record.operationId}>
          <p className={styles.author}>{record.author}</p>
          <Markdown content={record.markdown} />
        </article>
      ))}
      {value?.hasPdf && (
        <div className={styles.pdf}>
          <PdfReader src={`${endpoint}?pdf=1`} title="Shared exercise PDF" />
        </div>
      )}
      {value && !value.document && !value.exercises.length && !value.hasPdf && (
        <p>No canvas or exercises were saved in this snapshot.</p>
      )}
    </section>
  );
}

export function PaperExercises({
  topic,
  slug,
  editable,
}: {
  topic: string;
  slug: string;
  editable: boolean;
}) {
  const endpoint = `/api/v1/papers/${topic}/${slug}/exercises`;
  const [records, setRecords] = useState<ExerciseRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const [markdown, setMarkdown] = useState("");
  const [saving, setSaving] = useState(false);
  const operation = useRef<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  useEffect(() => {
    if (!opened) return;
    let stopped = false;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch(endpoint, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error(
            "Exercises could not sync. Check collaboration access and local changes.",
          );
        const data = (await response.json()) as { records: ExerciseRecord[] };
        if (!stopped) {
          setRecords(data.records);
          setError(null);
        }
      } catch (error) {
        if (!stopped)
          setError(
            error instanceof Error
              ? error.message
              : "Exercises could not be loaded.",
          );
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 30_000);
    return () => {
      stopped = true;
      controller.abort();
      window.clearInterval(interval);
    };
  }, [endpoint, opened, refreshVersion]);
  const save = async () => {
    if (saving || !markdown.trim()) return;
    setSaving(true);
    setError(null);
    try {
      operation.current ??= Array.from(
        crypto.getRandomValues(new Uint8Array(16)),
        (value) => value.toString(16).padStart(2, "0"),
      ).join("");
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ markdown, operationId: operation.current }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok)
        throw new Error(
          payload.error ??
            "The exercise could not be saved. Retry to recover the same save.",
        );
      setMarkdown("");
      operation.current = null;
      setRefreshVersion((version) => version + 1);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "The exercise could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <details
      className={styles.root}
      onToggle={(event) => setOpened(event.currentTarget.open)}
    >
      <summary>Exercises</summary>
      {editable && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label htmlFor={`exercise-${topic}-${slug}`}>Add an exercise</label>
          <textarea
            id={`exercise-${topic}-${slug}`}
            value={markdown}
            maxLength={100_000}
            disabled={saving}
            onChange={(event) => {
              setMarkdown(event.target.value);
              operation.current = null;
            }}
          />
          <button type="submit" disabled={saving || !markdown.trim()}>
            {saving ? "Saving exercise…" : "Save exercise"}
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {records.map((record) => (
        <article className={styles.record} key={record.operationId}>
          <p className={styles.author}>{record.author}</p>
          <Markdown content={record.markdown} />
        </article>
      ))}
      {records.length > 0 && (
        <div className={styles.pdf}>
          <PdfReader
            src={`${endpoint}/pdf`}
            title="Exercise PDF"
            editable={editable}
          />
        </div>
      )}
      {opened && !records.length && !error && <p>No exercises saved yet.</p>}
    </details>
  );
}
