"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./ModelPicker.module.css";

/**
 * Admin control: which provider answers (claude-code, codex, or an API key)
 * and with which of its currently offered models. The model list is live
 * from the provider's API when reachable, curated otherwise.
 */

type Readiness =
  | "ready"
  | "no_key"
  | "no_model"
  | "not_installed"
  | "not_authenticated"
  | "unreachable"
  | "checking";

const READINESS_LABEL: Record<Readiness, string> = {
  ready: "ready",
  no_key: "needs API key",
  no_model: "select a model",
  not_installed: "CLI not installed",
  not_authenticated: "CLI needs login",
  unreachable: "endpoint or SSH host not answering",
  checking: "checking availability",
};

interface AgentState {
  provider: string | null;
  statuses: Record<string, Readiness>;
  model: string | null;
  baseUrl: string | null;
  baseUrlPlaceholder: string | null;
  endpointConfigurable: boolean;
  suggestions: string[];
  liveList: boolean;
  admin: boolean;
  available?: boolean;
}

export function ModelPicker() {
  const [state, setState] = useState<AgentState | null>(null);
  const [value, setValue] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestVersion = useRef(0);

  async function refreshDetails(
    version: number,
    announce: boolean,
  ): Promise<void> {
    try {
      const response = await fetch("/api/v1/agent/model?probe=1", {
        credentials: "include",
      });
      if (!response.ok || version !== requestVersion.current) return;
      const data = (await response.json()) as AgentState;
      if (version !== requestVersion.current) return;
      setState(data);
      if (announce) {
        setStatus(
          data.available
            ? `${data.provider} answers with ${data.model ?? "its default model"}.`
            : `Saved, but ${data.provider} is not answering. It may need its CLI, key, or SSH host on the server.`,
        );
      }
    } catch {
      if (announce && version === requestVersion.current) {
        setStatus("Saved. Could not refresh provider availability.");
      }
    }
  }

  useEffect(() => {
    const version = requestVersion.current;
    void fetch("/api/v1/agent/model", { credentials: "include" })
      .then((r) => r.json())
      .then((d: AgentState) => {
        if (version !== requestVersion.current) return;
        setState(d);
        setValue(d.model ?? "");
        setBaseUrl(d.baseUrl ?? "");
        void refreshDetails(version, false);
      });
  }, []);

  if (!state?.admin) return null;
  const draftModel = value.trim() || null;
  const modelChanged = draftModel !== state.model;
  const draftBaseUrl = baseUrl.trim() || null;
  const endpointChanged = draftBaseUrl !== state.baseUrl;

  async function save(body: {
    provider?: string;
    model?: string | null;
    baseUrl?: string | null;
  }): Promise<void> {
    const password = window.prompt(
      "Enter your profile password to authorize this system change.",
    );
    if (password === null) return;
    const version = requestVersion.current + 1;
    requestVersion.current = version;
    setBusy(true);
    setStatus(null);
    const res = await fetch("/api/v1/agent/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ ...body, password }),
    });
    const data = (await res.json()) as AgentState & { error?: string };
    setBusy(false);
    if (!res.ok) {
      setStatus(data.error ?? "Could not save.");
      return;
    }
    setState(data);
    setValue(data.model ?? "");
    setBaseUrl(data.baseUrl ?? "");
    setStatus("Saved. Checking provider availability…");
    void refreshDetails(version, true);
  }

  return (
    <div className={styles.root}>
      <div className={styles.current} aria-live="polite">
        <span className={styles.currentLabel}>Current</span>
        <span className={styles.currentValue}>
          <strong>{state.provider ?? "Not configured"}</strong>
          {state.provider && <span aria-hidden="true">/</span>}
          {state.provider && <code>{state.model ?? "provider default"}</code>}
        </span>
      </div>
      <p className={styles.line}>Provider</p>
      <div className={styles.controls}>
        {Object.entries(state.statuses).map(([p, readiness]) => (
          <button
            key={p}
            type="button"
            className={state.provider === p ? styles.chipActive : styles.chip}
            onClick={() => void save({ provider: p })}
            disabled={busy || state.provider === p}
            aria-pressed={state.provider === p}
            aria-label={`${p}: ${READINESS_LABEL[readiness]}`}
            title={
              readiness === "ready" ? undefined : READINESS_LABEL[readiness]
            }
          >
            <span
              className={
                readiness === "ready"
                  ? styles.readyDot
                  : readiness === "checking"
                    ? styles.checkingDot
                    : styles.notReadyDot
              }
              aria-hidden="true"
            />
            {p}
            {readiness !== "ready" && readiness !== "checking" && (
              <span className={styles.readinessNote}>
                {READINESS_LABEL[readiness]}
              </span>
            )}
          </button>
        ))}
      </div>
      {state.endpointConfigurable && (
        <>
          <p className={styles.line}>
            Endpoint{" "}
            <span className={styles.hint}>
              (HTTP(S), reachable from the papernook server)
            </span>
          </p>
          <div className={styles.controls}>
            <input
              className={styles.input}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={
                state.baseUrlPlaceholder ??
                (state.provider === "openai"
                  ? "https://api.openai.com/v1"
                  : "http://localhost:8000")
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void save({ baseUrl: baseUrl.trim() || null });
                }
              }}
              disabled={busy}
              inputMode="url"
            />
            <button
              type="button"
              className={styles.save}
              onClick={() => void save({ baseUrl: draftBaseUrl })}
              disabled={busy || !endpointChanged}
            >
              Save endpoint
            </button>
          </div>
        </>
      )}
      <p className={styles.line}>
        Model{" "}
        <span className={styles.hint}>
          {state.liveList
            ? "(live list from the provider)"
            : state.provider === "claude-code"
              ? "(aliases track the latest release; exact ids also work)"
              : "(common choices; any id the provider accepts works)"}
        </span>
      </p>
      <div className={styles.controls}>
        {state.suggestions.slice(0, 8).map((s) => (
          <button
            key={s}
            type="button"
            className={state.model === s ? styles.chipActive : styles.chip}
            onClick={() => void save({ model: s })}
            disabled={busy || state.model === s}
            aria-pressed={state.model === s}
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
          onClick={() => void save({ model: draftModel })}
          disabled={busy || !modelChanged}
        >
          Save
        </button>
      </div>
      {modelChanged && <p className={styles.draftNote}>Unsaved model change</p>}
      {status && (
        <p className={styles.status} role="status" aria-live="polite">
          {status}
        </p>
      )}
    </div>
  );
}
