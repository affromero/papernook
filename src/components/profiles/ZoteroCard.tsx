"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./ZoteroCard.module.css";

interface ZoteroTarget {
  type: "user" | "group";
  id: string;
  name: string;
}

interface ZoteroCollection {
  key: string;
  name: string;
  parentCollection: string | null;
}

interface ZoteroState {
  connected: boolean;
  userId: string | null;
  target: ZoteroTarget | null;
  collectionKeys: string[];
  syncing: boolean;
  lastResult: {
    imported: number;
    updated: number;
    skipped: number;
    failed: number;
  } | null;
}

interface ZoteroOptions extends ZoteroState {
  libraries: ZoteroTarget[];
  collections: ZoteroCollection[];
  previewTarget: ZoteroTarget;
  warning: string | null;
}

function targetValue(target: ZoteroTarget): string {
  return `${target.type}:${target.id}`;
}

export function ZoteroCard() {
  const [state, setState] = useState<ZoteroState | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<ZoteroOptions | null>(null);
  const [selectedTarget, setSelectedTarget] = useState("");
  const [selectedCollections, setSelectedCollections] = useState<string[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function refresh(): Promise<ZoteroState | null> {
    const response = await fetch("/api/v1/settings/zotero", {
      credentials: "include",
    });
    if (!response.ok) return null;
    const data = (await response.json()) as ZoteroState;
    setState(data);
    return data;
  }

  useEffect(() => {
    void fetch("/api/v1/settings/zotero", { credentials: "include" })
      .then((response) =>
        response.ok ? (response.json() as Promise<ZoteroState>) : null,
      )
      .then((data) => {
        if (data) setState(data);
      });
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  function watchSync(): void {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => {
      void refresh().then((data) => {
        if (data && !data.syncing && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setStatus(
            data.lastResult?.failed
              ? `Sync imported ${data.lastResult.imported}, refreshed ${data.lastResult.updated}; ${data.lastResult.failed} failed and will retry automatically.`
              : `Sync finished: ${data.lastResult?.imported ?? 0} imported and ${data.lastResult?.updated ?? 0} refreshed.`,
          );
        }
      });
    }, 3000);
  }

  async function call(method: "PUT" | "POST" | "DELETE"): Promise<void> {
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch("/api/v1/settings/zotero", {
        method,
        credentials: "include",
        ...(method === "PUT"
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ apiKey: apiKey.trim() }),
            }
          : {}),
      });
      const data = (await response.json()) as ZoteroState & { error?: string };
      if (!response.ok) {
        setStatus(data.error ?? "Something went wrong.");
        return;
      }
      setState(data);
      setOptions(null);
      if (method === "PUT") {
        setApiKey("");
        setStatus("Connected to your personal Zotero library.");
      }
      if (method === "DELETE") setStatus("Disconnected.");
      if (method === "POST") {
        setStatus("Sync started…");
        watchSync();
      }
    } catch {
      setStatus("Could not reach the Zotero settings service.");
    } finally {
      setBusy(false);
    }
  }

  async function loadOptions(target?: ZoteroTarget): Promise<void> {
    setBusy(true);
    setStatus(null);
    try {
      const params = new URLSearchParams({ options: "1" });
      if (target) {
        params.set("libraryType", target.type);
        params.set("libraryId", target.id);
      }
      const response = await fetch(
        `/api/v1/settings/zotero?${params.toString()}`,
        { credentials: "include" },
      );
      const data = (await response.json()) as ZoteroOptions & {
        error?: string;
      };
      if (!response.ok) {
        setStatus(data.error ?? "Could not load Zotero libraries.");
        return;
      }
      setOptions(data);
      setSelectedTarget(targetValue(data.previewTarget));
      const available = new Set(
        data.collections.map((collection) => collection.key),
      );
      const isConfiguredTarget =
        state?.target?.type === data.previewTarget.type &&
        state?.target?.id === data.previewTarget.id;
      setSelectedCollections(
        isConfiguredTarget
          ? data.collectionKeys.filter((key) => available.has(key))
          : [],
      );
      if (data.warning) setStatus(data.warning);
    } catch {
      setStatus("Could not load Zotero libraries.");
    } finally {
      setBusy(false);
    }
  }

  async function changeTarget(value: string): Promise<void> {
    const target = options?.libraries.find(
      (library) => targetValue(library) === value,
    );
    if (!target) return;
    setSelectedTarget(value);
    await loadOptions(target);
  }

  async function saveScope(): Promise<void> {
    const target = options?.libraries.find(
      (library) => targetValue(library) === selectedTarget,
    );
    if (!target) return;
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch("/api/v1/settings/zotero", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: { type: target.type, id: target.id },
          collectionKeys: selectedCollections,
        }),
      });
      const data = (await response.json()) as ZoteroState & { error?: string };
      if (!response.ok) {
        setStatus(data.error ?? "Could not save the Zotero sync source.");
        return;
      }
      setState(data);
      setOptions(null);
      setStatus(
        selectedCollections.length === 0
          ? `Syncing all of ${target.name}.`
          : `Syncing ${selectedCollections.length} selected collection${selectedCollections.length === 1 ? "" : "s"} in ${target.name}.`,
      );
    } catch {
      setStatus("Could not save the Zotero sync source.");
    } finally {
      setBusy(false);
    }
  }

  if (!state) return null;

  if (!state.connected) {
    return (
      <div className={styles.root}>
        <p className={styles.line}>
          Create a dedicated key at{" "}
          <a
            href="https://www.zotero.org/settings/keys/new"
            target="_blank"
            rel="noreferrer"
          >
            zotero.org/settings/keys
          </a>
          . Enable read access to your personal library and files and/or any
          groups you want to sync. Write access is not needed.
        </p>
        <div className={styles.controls}>
          <input
            className={styles.input}
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="Zotero API key"
            onKeyDown={(event) => {
              if (event.key === "Enter" && apiKey.trim()) void call("PUT");
            }}
            disabled={busy}
          />
          <button
            type="button"
            className={styles.save}
            onClick={() => void call("PUT")}
            disabled={busy || !apiKey.trim()}
          >
            Connect
          </button>
        </div>
        {status && (
          <p className={styles.status} role="status">
            {status}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <p className={styles.line}>
        Connected to <strong>{state.target?.name ?? "My Library"}</strong>.
        {state.collectionKeys.length === 0
          ? " All collections are included."
          : ` ${state.collectionKeys.length} collection filter${state.collectionKeys.length === 1 ? " is" : "s are"} active.`}{" "}
        New PDFs sync every 30 minutes.
      </p>

      {options && (
        <div className={styles.scope}>
          <label>
            Zotero library
            <select
              className={styles.select}
              value={selectedTarget}
              onChange={(event) => void changeTarget(event.target.value)}
              disabled={busy}
            >
              {options.libraries.map((library) => (
                <option key={targetValue(library)} value={targetValue(library)}>
                  {library.name}
                  {library.type === "group" ? " (group)" : ""}
                </option>
              ))}
            </select>
          </label>
          <fieldset className={styles.collections}>
            <legend>Collections</legend>
            <p className={styles.hint}>
              Select none to sync the entire library. Subcollections are
              included automatically.
            </p>
            <div className={styles.collectionList}>
              {options.collections.map((collection) => (
                <label key={collection.key} className={styles.collection}>
                  <input
                    type="checkbox"
                    checked={selectedCollections.includes(collection.key)}
                    onChange={(event) =>
                      setSelectedCollections((current) =>
                        event.target.checked
                          ? [...current, collection.key]
                          : current.filter((key) => key !== collection.key),
                      )
                    }
                  />
                  {collection.name}
                </label>
              ))}
              {options.collections.length === 0 && (
                <span className={styles.hint}>
                  No collections in this library.
                </span>
              )}
            </div>
          </fieldset>
          <div className={styles.controls}>
            <button
              type="button"
              className={styles.save}
              onClick={() => void saveScope()}
              disabled={busy}
            >
              Save sync source
            </button>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => setOptions(null)}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {!options && (
        <div className={styles.controls}>
          <button
            type="button"
            className={styles.save}
            onClick={() => void call("POST")}
            disabled={busy || state.syncing}
          >
            {state.syncing ? "Syncing…" : "Sync now"}
          </button>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => void loadOptions()}
            disabled={busy || state.syncing}
          >
            Library & collections
          </button>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => void call("DELETE")}
            disabled={busy || state.syncing}
          >
            Disconnect
          </button>
        </div>
      )}
      {status && (
        <p className={styles.status} role="status">
          {status}
        </p>
      )}
    </div>
  );
}
