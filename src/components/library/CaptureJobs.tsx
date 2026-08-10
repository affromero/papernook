"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./CaptureJobs.module.css";

export interface CaptureJobView {
  slug: string;
  state: "analyzing" | "failed";
  sourceUrl: string;
  startedAt: string;
  error?: string;
}

function shortSource(sourceUrl: string): string {
  try {
    const url = new URL(sourceUrl);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return sourceUrl;
  }
}

function Elapsed({ since }: { since: string }) {
  // Computed after mount only — SSR HTML must not carry a clock-dependent
  // value that mismatches on hydration.
  const [label, setLabel] = useState("");
  useEffect(() => {
    const update = () => {
      const minutes = Math.max(
        0,
        Math.round((Date.now() - Date.parse(since)) / 60_000),
      );
      setLabel(minutes < 1 ? "just started" : `${minutes} min`);
    };
    update();
    const timer = setInterval(update, 30_000);
    return () => clearInterval(timer);
  }, [since]);
  return <span className={styles.elapsed}>{label}</span>;
}

/** In-flight and failed capture jobs, shown in the inbox view. */
export function CaptureJobs({ jobs }: { jobs: CaptureJobView[] }) {
  const router = useRouter();
  const analyzing = jobs.some((job) => job.state === "analyzing");

  useEffect(() => {
    if (!analyzing) return;
    const timer = setInterval(() => router.refresh(), 5_000);
    return () => clearInterval(timer);
  }, [analyzing, router]);

  async function dismiss(slug: string): Promise<void> {
    await fetch(`/api/v1/inbox/${slug}`, {
      method: "DELETE",
      credentials: "include",
    });
    router.refresh();
  }

  if (jobs.length === 0) return null;
  return (
    <ul className={styles.list} aria-label="Captures in progress">
      {jobs.map((job) => (
        <li
          key={job.slug}
          className={job.state === "failed" ? styles.failed : styles.analyzing}
        >
          <div className={styles.body}>
            <span className={styles.source}>{shortSource(job.sourceUrl)}</span>
            {job.state === "analyzing" ? (
              <span className={styles.status}>
                Analyzing… <Elapsed since={job.startedAt} />
              </span>
            ) : (
              <span className={styles.status} role="alert">
                {job.error ?? "Capture failed."}
              </span>
            )}
          </div>
          {job.state === "failed" && (
            <button
              type="button"
              className={styles.dismiss}
              onClick={() => void dismiss(job.slug)}
            >
              Dismiss
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
