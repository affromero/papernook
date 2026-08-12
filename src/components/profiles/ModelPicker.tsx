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
  effort: string | null;
  effortOptions: string[];
  defaultEffort: string | null;
  baseUrl: string | null;
  baseUrlPlaceholder: string | null;
  endpointConfigurable: boolean;
  suggestions: string[];
  liveList: boolean;
  admin: boolean;
  available?: boolean;
  webAccess: boolean;
  webCapable: boolean;
  credentialReloadAvailable: boolean;
}

interface Feedback {
  tone: "info" | "success" | "error";
  label: string;
  message: string;
}

export function ModelPicker() {
  const [state, setState] = useState<AgentState | null>(null);
  const [value, setValue] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
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
        setFeedback(
          data.available
            ? {
                tone: "success",
                label: "Provider ready",
                message: `${data.provider} answers with ${data.model ?? "its default model"} at ${data.effort ?? data.defaultEffort ?? "default"} effort.`,
              }
            : {
                tone: "error",
                label: "Provider unavailable",
                message: `Saved, but ${data.provider} is not answering. It may need its CLI, key, or SSH host on the server.`,
              },
        );
      }
    } catch {
      if (announce && version === requestVersion.current) {
        setFeedback({
          tone: "error",
          label: "Availability check failed",
          message: "Saved. Could not refresh provider availability.",
        });
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
    effort?: string | null;
    baseUrl?: string | null;
    webAccess?: boolean;
  }): Promise<void> {
    const version = requestVersion.current + 1;
    requestVersion.current = version;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/v1/agent/model", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as AgentState & { error?: string };
      if (!res.ok) {
        setFeedback({
          tone: "error",
          label: "Settings not saved",
          message: data.error ?? "Could not save.",
        });
        return;
      }
      setState(data);
      setValue(data.model ?? "");
      setBaseUrl(data.baseUrl ?? "");
      setFeedback({
        tone: "info",
        label: "Settings saved",
        message: "Checking provider availability…",
      });
      void refreshDetails(version, true);
    } catch {
      setFeedback({
        tone: "error",
        label: "Settings not saved",
        message: "Could not save. Check the server connection and try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function reloadCredentials(): Promise<void> {
    if (
      !window.confirm(
        "Reload the latest CLI login from this server? Active chats are not interrupted.",
      )
    ) {
      return;
    }
    setBusy(true);
    setFeedback({
      tone: "info",
      label: "Reloading CLI login",
      message: "Reading the latest credentials from this server…",
    });
    try {
      const response = await fetch("/api/v1/settings/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      const data = (await response.json()) as {
        error?: string;
        readiness?: Readiness;
      };
      if (!response.ok) {
        setFeedback({
          tone: "error",
          label: "CLI login not reloaded",
          message: data.error ?? "Could not reload CLI login.",
        });
        return;
      }
      const version = requestVersion.current + 1;
      requestVersion.current = version;
      setFeedback(
        data.readiness === "ready"
          ? {
              tone: "success",
              label: "CLI login reloaded",
              message: "The provider is ready.",
            }
          : {
              tone: "error",
              label: "Provider still unavailable",
              message:
                "CLI login reloaded, but the provider still needs login.",
            },
      );
      await refreshDetails(version, false);
    } catch {
      setFeedback({
        tone: "error",
        label: "CLI login not reloaded",
        message: "Could not reload CLI login. Check the server connection.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function testModel(): Promise<void> {
    setBusy(true);
    setFeedback({
      tone: "info",
      label: "Testing selected model",
      message: "Waiting for one short response…",
    });
    try {
      const response = await fetch("/api/v1/agent/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({}),
      });
      const data = (await response.json()) as {
        error?: string;
        provider?: string;
        reply?: string;
        elapsedMs?: number;
      };
      if (!response.ok) {
        setFeedback({
          tone: "error",
          label: "Model test failed",
          message: data.error ?? "The selected model did not answer.",
        });
        return;
      }
      const seconds = ((data.elapsedMs ?? 0) / 1000).toFixed(1);
      setFeedback({
        tone: "success",
        label: "Model test passed",
        message: `${data.provider} answered in ${seconds}s: ${data.reply ?? "(empty response)"}`,
      });
    } catch {
      setFeedback({
        tone: "error",
        label: "Model test failed",
        message: "Could not test the model. Check the server connection.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.current} aria-live="polite">
        <span className={styles.currentLabel}>Current</span>
        <span className={styles.currentValue}>
          <strong>{state.provider ?? "Not configured"}</strong>
          {state.provider && <span aria-hidden="true">/</span>}
          {state.provider && <code>{state.model ?? "provider default"}</code>}
          {state.provider && state.effort && <code>{state.effort} effort</code>}
        </span>
      </div>
      {state.provider && (
        <div className={styles.reloadRow}>
          <button
            type="button"
            className={styles.secondaryAction}
            disabled={busy}
            onClick={() => void testModel()}
          >
            Test selected model
          </button>
          <span className={styles.hint}>
            Sends one short prompt without web access or chat history.
          </span>
        </div>
      )}
      {feedback && (
        <div
          className={styles.status}
          data-tone={feedback.tone}
          role={feedback.tone === "error" ? "alert" : "status"}
          aria-atomic="true"
        >
          <span className={styles.statusMark} aria-hidden="true">
            {feedback.tone === "error"
              ? "!"
              : feedback.tone === "success"
                ? "✓"
                : "…"}
          </span>
          <span className={styles.statusCopy}>
            <strong>{feedback.label}</strong>
            <span>{feedback.message}</span>
          </span>
        </div>
      )}
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
      {state.credentialReloadAvailable && (
        <div className={styles.reloadRow}>
          <button
            type="button"
            className={styles.secondaryAction}
            disabled={busy}
            onClick={() => void reloadCredentials()}
          >
            Reload CLI login
          </button>
          <span className={styles.hint}>
            Use after signing in or out with the CLI on this server.
          </span>
        </div>
      )}
      {state.provider === "codex" && (
        <p className={styles.hint} role="note">
          Heads up: codex runs with a read-only sandbox that can still read
          library data if a malicious paper prompt-injects a turn. On a public
          instance with several profiles, only keep it selected if you trust
          every account holder.
        </p>
      )}
      {state.webCapable && (
        <>
          <p className={styles.line}>Web access</p>
          <div className={styles.switchRow}>
            <button
              type="button"
              className={styles.switch}
              role="switch"
              aria-checked={state.webAccess}
              aria-label="Allow chats to search the web"
              disabled={busy}
              onClick={() => void save({ webAccess: !state.webAccess })}
            >
              <span className={styles.switchTrack} aria-hidden="true">
                <span className={styles.switchThumb} />
              </span>
              <span className={styles.switchText}>
                <strong>{state.webAccess ? "On" : "Off"}</strong>
                <span>Chats may search the web</span>
              </span>
            </button>
          </div>
          <p className={styles.hint}>
            On by default. A malicious paper could steer a web request. Answers
            gain live lookups; nothing on this server becomes readable.
          </p>
        </>
      )}
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
      {state.effortOptions.length > 0 && (
        <>
          <p className={styles.line}>
            Thinking effort{" "}
            <span className={styles.hint}>
              {state.defaultEffort
                ? `(model default: ${state.defaultEffort})`
                : "(default follows the selected model)"}
            </span>
          </p>
          <div className={styles.controls}>
            <button
              type="button"
              className={
                state.effort === null ? styles.chipActive : styles.chip
              }
              onClick={() => void save({ effort: null })}
              disabled={busy || state.effort === null}
              aria-pressed={state.effort === null}
            >
              Default
            </button>
            {state.effortOptions.map((effort) => (
              <button
                key={effort}
                type="button"
                className={
                  state.effort === effort ? styles.chipActive : styles.chip
                }
                onClick={() => void save({ effort })}
                disabled={busy || state.effort === effort}
                aria-pressed={state.effort === effort}
              >
                {effort}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
