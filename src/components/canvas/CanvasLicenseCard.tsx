"use client";

import { useEffect, useState } from "react";
import styles from "./CanvasLicenseCard.module.css";

interface LicenseState {
  configured: boolean;
  source: "file" | "environment" | null;
  admin: boolean;
  error?: string;
}

export function CanvasLicenseCard() {
  const [state, setState] = useState<LicenseState | null>(null);
  const [licenseKey, setLicenseKey] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetch("/api/v1/settings/canvas", {
      credentials: "include",
      cache: "no-store",
    })
      .then(async (response) => {
        const data = (await response.json()) as LicenseState;
        if (!response.ok) throw new Error(data.error ?? "Could not load.");
        setState(data);
      })
      .catch((error: unknown) => {
        setStatus(
          error instanceof Error
            ? error.message
            : "The canvas configuration could not be loaded.",
        );
      });
  }, []);

  async function save(nextLicenseKey: string | null): Promise<void> {
    const password = window.prompt(
      "Enter your profile password to authorize this system change.",
    );
    if (password === null) return;
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch("/api/v1/settings/canvas", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ licenseKey: nextLicenseKey, password }),
      });
      const data = (await response.json()) as LicenseState;
      if (!response.ok) {
        throw new Error(data.error ?? "The license key could not be saved.");
      }
      setState(data);
      setLicenseKey("");
      setStatus(
        nextLicenseKey === null
          ? data.source === "environment"
            ? "Stored override removed. The server environment key is active."
            : "License key removed."
          : "License key saved. Reopen Canvas to activate it.",
      );
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : "The license key could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!state) {
    return (
      <div className={styles.root}>
        <p className={styles.status} role="status">
          {status ?? "Checking Canvas license…"}
        </p>
      </div>
    );
  }

  if (!state.admin) {
    return (
      <div className={styles.root}>
        <p className={styles.summary}>
          {state.configured
            ? "Canvas is licensed for this server."
            : "Your admin needs to add a tldraw license before Canvas can open."}
        </p>
        {!state.configured && (
          <a
            className={styles.link}
            href="https://tldraw.dev/pricing"
            target="_blank"
            rel="noreferrer"
          >
            About tldraw licenses <span aria-hidden="true">↗</span>
          </a>
        )}
      </div>
    );
  }

  const sourceLabel =
    state.source === "file"
      ? "Saved in papernook"
      : state.source === "environment"
        ? "Managed by the server environment"
        : "Not configured";

  return (
    <div className={styles.root}>
      <div className={styles.current}>
        <span
          className={state.configured ? styles.dotReady : styles.dotMissing}
          aria-hidden="true"
        />
        <div>
          <strong>
            {state.configured ? "Canvas licensed" : "License needed"}
          </strong>
          <span>{sourceLabel}</span>
        </div>
      </div>
      <p className={styles.summary}>
        Production Canvas requires a tldraw hobby, trial, or commercial key.
        Keys are public and validated by tldraw in the browser.
      </p>
      <a
        className={styles.link}
        href="https://tldraw.dev/pricing"
        target="_blank"
        rel="noreferrer"
      >
        Get a tldraw key <span aria-hidden="true">↗</span>
      </a>
      <div className={styles.controls}>
        <label className={styles.field}>
          <span>License key</span>
          <input
            type="password"
            value={licenseKey}
            onChange={(event) => setLicenseKey(event.target.value)}
            placeholder={
              state.configured
                ? "Paste a replacement key"
                : "Paste your tldraw key"
            }
            autoComplete="off"
            disabled={busy}
          />
        </label>
        <button
          type="button"
          className={styles.save}
          onClick={() => void save(licenseKey.trim())}
          disabled={busy || licenseKey.trim().length === 0}
        >
          Save key
        </button>
      </div>
      {state.source === "file" && (
        <button
          type="button"
          className={styles.remove}
          onClick={() => void save(null)}
          disabled={busy}
        >
          Remove stored key
        </button>
      )}
      {status && (
        <p className={styles.status} role="status">
          {status}
        </p>
      )}
    </div>
  );
}
