"use client";

import dynamicImport from "next/dynamic";
import { useEffect, useState } from "react";
import styles from "./CanvasLicenseCard.module.css";

const CanvasLicenseProbe = dynamicImport(
  () =>
    import("./CanvasLicenseProbe").then((module) => ({
      default: module.CanvasLicenseProbe,
    })),
  { ssr: false },
);

interface LicenseState {
  configured: boolean;
  source: "file" | "environment" | null;
  admin: boolean;
  requiredForThisOrigin: boolean;
  licenseKey?: string | null;
  error?: string;
}

type TestState = "idle" | "testing" | "valid" | "rejected";

export function CanvasLicenseCard() {
  const [state, setState] = useState<LicenseState | null>(null);
  const [licenseKey, setLicenseKey] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testState, setTestState] = useState<TestState>("idle");

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
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch("/api/v1/settings/canvas", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ licenseKey: nextLicenseKey }),
      });
      const data = (await response.json()) as LicenseState;
      if (!response.ok) {
        throw new Error(data.error ?? "The license key could not be saved.");
      }
      setState(data);
      setLicenseKey("");
      setTestState("idle");
      setStatus(
        nextLicenseKey === null
          ? data.source === "environment"
            ? "Stored override removed. The server environment key is active."
            : "License key removed."
          : "Key saved. Open Canvas to validate it in the browser.",
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
            ? "A Canvas key is configured. tldraw validates it when Canvas opens."
            : state.requiredForThisOrigin
              ? "Your admin needs to add a tldraw key before Canvas can open."
              : "Canvas works on this local address without a key. A key is required after production deployment."}
        </p>
        {!state.configured && state.requiredForThisOrigin && (
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
    <div className={styles.root} aria-busy={busy}>
      <div className={styles.current}>
        <span
          className={state.configured ? styles.dotReady : styles.dotMissing}
          aria-hidden="true"
        />
        <div>
          <strong>
            {state.configured
              ? "Key configured"
              : state.requiredForThisOrigin
                ? "Key needed"
                : "Ready locally"}
          </strong>
          <span>{sourceLabel}</span>
        </div>
      </div>
      <p className={styles.summary}>
        {state.requiredForThisOrigin
          ? "Canvas on this production address requires a tldraw hobby, trial, or commercial key."
          : "Canvas works on this local address without a key. Add one before production deployment."}{" "}
        The key is sent to tldraw in the browser; it is not a secret credential.
      </p>
      <a
        className={styles.link}
        href="https://tldraw.dev/pricing"
        target="_blank"
        rel="noreferrer"
      >
        Get a tldraw key <span aria-hidden="true">↗</span>
      </a>
      {state.configured && state.requiredForThisOrigin && state.licenseKey && (
        <div className={styles.testRow}>
          <button
            type="button"
            className={styles.test}
            onClick={() => setTestState("testing")}
            disabled={busy || testState === "testing"}
          >
            {testState === "testing" ? "Testing key…" : "Test configured key"}
          </button>
          <span
            className={
              testState === "valid"
                ? styles.testValid
                : testState === "rejected"
                  ? styles.testRejected
                  : styles.testHint
            }
            role="status"
          >
            {testState === "testing"
              ? "Checking signature, domain, and expiry…"
              : testState === "valid"
                ? "Valid for this domain."
                : testState === "rejected"
                  ? "Rejected. Replace the key or check its allowed domain."
                  : "Runs tldraw validation in this browser."}
          </span>
        </div>
      )}
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
          {busy ? "Saving…" : "Save key"}
        </button>
      </div>
      {state.source === "file" && (
        <button
          type="button"
          className={styles.remove}
          onClick={() => {
            if (
              window.confirm(
                "Remove the stored Canvas key for everyone? The server environment key will be used if one exists.",
              )
            ) {
              void save(null);
            }
          }}
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
      {testState === "testing" && state.licenseKey && (
        <CanvasLicenseProbe
          licenseKey={state.licenseKey}
          onResult={(valid) => setTestState(valid ? "valid" : "rejected")}
        />
      )}
    </div>
  );
}
