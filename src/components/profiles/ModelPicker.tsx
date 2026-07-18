"use client";

import { useEffect, useState } from "react";
import styles from "./ModelPicker.module.css";

/**
 * Admin control: which model the configured provider runs. Suggestions per
 * provider plus free text; empty means the provider's own default.
 */

interface ModelState {
  provider: string | null;
  model: string | null;
  suggestions: string[];
  admin: boolean;
}

export function ModelPicker() {
  const [state, setState] = useState<ModelState | null>(null);
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetch("/api/v1/agent/model", { credentials: "include" })
      .then((r) => r.json())
      .then((d: ModelState) => {
        setState(d);
        setValue(d.model ?? "");
      });
  }, []);

  if (!state?.provider || !state.admin) return null;

  async function save(next: string): Promise<void> {
    setBusy(true);
    setStatus(null);
    const res = await fetch("/api/v1/agent/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ model: next || null }),
    });
    const data = (await res.json()) as {
      model?: string | null;
      available?: boolean;
      error?: string;
    };
    setBusy(false);
    if (!res.ok) {
      setStatus(data.error ?? "Could not save.");
      return;
    }
    setValue(data.model ?? "");
    setStatus(
      data.available
        ? `Saved. ${state?.provider} answers with ${data.model ?? "its default model"}.`
        : "Saved, but the provider is not answering; check the server.",
    );
  }

  return (
    <div className={styles.root}>
      <p className={styles.line}>
        Provider <code>{state.provider}</code> · model:
      </p>
      <div className={styles.controls}>
        {state.suggestions.map((s) => (
          <button
            key={s}
            type="button"
            className={value === s ? styles.chipActive : styles.chip}
            onClick={() => void save(s)}
            disabled={busy}
          >
            {s}
          </button>
        ))}
        <input
          className={styles.input}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="custom model id (empty = default)"
          onKeyDown={(e) => {
            if (e.key === "Enter") void save(value.trim());
          }}
          disabled={busy}
        />
        <button
          type="button"
          className={styles.save}
          onClick={() => void save(value.trim())}
          disabled={busy}
        >
          Save
        </button>
      </div>
      {status && <p className={styles.status}>{status}</p>}
    </div>
  );
}
