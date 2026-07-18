"use client";

import { useEffect, useState } from "react";
import styles from "./ModelPicker.module.css";

/**
 * Admin control: which provider answers (claude-code, codex, or an API key)
 * and with which of its currently offered models. The model list is live
 * from the provider's API when reachable, curated otherwise.
 */

interface AgentState {
  provider: string | null;
  providers: string[];
  model: string | null;
  suggestions: string[];
  liveList: boolean;
  admin: boolean;
  available?: boolean;
}

export function ModelPicker() {
  const [state, setState] = useState<AgentState | null>(null);
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetch("/api/v1/agent/model", { credentials: "include" })
      .then((r) => r.json())
      .then((d: AgentState) => {
        setState(d);
        setValue(d.model ?? "");
      });
  }, []);

  if (!state?.admin) return null;

  async function save(body: {
    provider?: string;
    model?: string | null;
  }): Promise<void> {
    setBusy(true);
    setStatus(null);
    const res = await fetch("/api/v1/agent/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as AgentState & { error?: string };
    setBusy(false);
    if (!res.ok) {
      setStatus(data.error ?? "Could not save.");
      return;
    }
    setState(data);
    setValue(data.model ?? "");
    setStatus(
      data.available
        ? `${data.provider} answers with ${data.model ?? "its default model"}.`
        : `Saved, but ${data.provider} is not answering. It may need its CLI, key, or SSH host on the server.`,
    );
  }

  return (
    <div className={styles.root}>
      <p className={styles.line}>Provider</p>
      <div className={styles.controls}>
        {state.providers.map((p) => (
          <button
            key={p}
            type="button"
            className={state.provider === p ? styles.chipActive : styles.chip}
            onClick={() => void save({ provider: p })}
            disabled={busy}
          >
            {p}
          </button>
        ))}
      </div>
      <p className={styles.line}>
        Model{" "}
        <span className={styles.hint}>
          {state.liveList
            ? "(live list from the provider)"
            : "(common choices; any id the provider accepts works)"}
        </span>
      </p>
      <div className={styles.controls}>
        {state.suggestions.slice(0, 8).map((s) => (
          <button
            key={s}
            type="button"
            className={value === s ? styles.chipActive : styles.chip}
            onClick={() => void save({ model: s })}
            disabled={busy}
          >
            {s}
          </button>
        ))}
      </div>
      <div className={styles.controls}>
        <input
          className={styles.input}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="custom model id (empty = provider default)"
          onKeyDown={(e) => {
            if (e.key === "Enter") void save({ model: value.trim() || null });
          }}
          disabled={busy}
        />
        <button
          type="button"
          className={styles.save}
          onClick={() => void save({ model: value.trim() || null })}
          disabled={busy}
        >
          Save
        </button>
      </div>
      {status && <p className={styles.status}>{status}</p>}
    </div>
  );
}
