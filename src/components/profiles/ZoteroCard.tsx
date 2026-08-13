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
    discovered: number;
    updated: number;
    removed: number;
    available: number;
    failed: number;
  } | null;
}

interface ZoteroOptions extends ZoteroState {
  libraries: (ZoteroTarget & { canImportFiles: boolean | null })[];
  collections: ZoteroCollection[];
  previewTarget: ZoteroTarget;
  warning: string | null;
}

interface ZoteroCatalogItem {
  key: string;
  title: string;
  authors: string[];
  year: number | null;
  annotationCount: number;
  hasStoredPdf: boolean;
  imported: { topic: string; slug: string } | null;
}

interface ZoteroCatalogPage {
  items: ZoteroCatalogItem[];
  total: number;
  importable: number;
  imported: number;
  page: number;
  limit: number;
  refreshedAt: string | null;
}

function targetValue(target: ZoteroTarget): string {
  return `${target.type}:${target.id}`;
}

async function fetchCatalog(
  query: string,
  page = 1,
): Promise<ZoteroCatalogPage | null> {
  const params = new URLSearchParams({
    q: query.trim(),
    page: String(page),
    limit: "20",
  });
  const response = await fetch(
    `/api/v1/settings/zotero/items?${params.toString()}`,
    { credentials: "include" },
  );
  return response.ok ? ((await response.json()) as ZoteroCatalogPage) : null;
}

export function ZoteroCard() {
  const [state, setState] = useState<ZoteroState | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<ZoteroOptions | null>(null);
  const [selectedTarget, setSelectedTarget] = useState("");
  const [selectedCollections, setSelectedCollections] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<ZoteroCatalogPage | null>(null);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [importingKey, setImportingKey] = useState<string | null>(null);
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
        if (!data) return;
        setState(data);
        if (data.connected) {
          void fetchCatalog("").then((catalogData) => {
            if (catalogData) setCatalog(catalogData);
          });
        }
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
              ? "Zotero catalog refresh failed. It will retry automatically."
              : `Catalog refreshed: ${data.lastResult?.available ?? 0} papers with stored PDFs; no PDFs downloaded and no AI calls made.`,
          );
          void loadCatalog();
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
        setCatalog(null);
        setStatus(
          "Connected. Refresh the metadata catalog to browse papers; nothing is downloaded automatically.",
        );
      }
      if (method === "DELETE") {
        setCatalog(null);
        setStatus("Disconnected.");
      }
      if (method === "POST") {
        setStatus("Refreshing metadata and annotations…");
        watchSync();
      }
    } catch {
      setStatus("Could not reach the Zotero settings service.");
    } finally {
      setBusy(false);
    }
  }

  async function loadCatalog(query = catalogQuery, page = 1): Promise<void> {
    try {
      const data = await fetchCatalog(query, page);
      if (data) setCatalog(data);
    } catch {
      setStatus("Could not load the Zotero catalog.");
    }
  }

  async function importItem(item: ZoteroCatalogItem): Promise<void> {
    setImportingKey(item.key);
    setStatus(
      `Importing “${item.title}”… This downloads one PDF and runs the configured AI analysis.`,
    );
    try {
      const response = await fetch("/api/v1/settings/zotero/items", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemKey: item.key }),
      });
      const data = (await response.json()) as {
        error?: string;
        topic?: string;
        slug?: string;
        created?: boolean;
      };
      if (!response.ok) {
        setStatus(data.error ?? "Could not import this Zotero paper.");
        return;
      }
      setStatus(
        data.created
          ? `Imported “${item.title}” into Papernook.`
          : `“${item.title}” was already in Papernook.`,
      );
      await loadCatalog(catalogQuery, catalog?.page ?? 1);
    } catch {
      setStatus("Could not import this Zotero paper.");
    } finally {
      setImportingKey(null);
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
      await loadCatalog();
      setStatus(
        selectedCollections.length === 0
          ? `Cataloging all of ${target.name}.`
          : `Cataloging ${selectedCollections.length} selected collection${selectedCollections.length === 1 ? "" : "s"} in ${target.name}.`,
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
            rel="noopener noreferrer"
          >
            zotero.org/settings/keys
          </a>
          . Enable library read access. File access is needed only when you
          explicitly import a PDF; write access is never needed.
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
        Metadata and annotations refresh every 30 minutes. PDFs are downloaded
        only when you explicitly import one, and catalog refreshes never call an
        AI provider.
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
            {options.libraries.find(
              (library) => targetValue(library) === selectedTarget,
            )?.canImportFiles === false && (
              <span className={styles.hint}>
                This key can catalog metadata but cannot download PDFs from this
                personal library. Enable file read access to import.
              </span>
            )}
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
            {state.syncing ? "Refreshing…" : "Refresh catalog"}
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
      {!options && catalog && (
        <div className={styles.catalog}>
          <div className={styles.catalogHeader}>
            <div>
              <strong>Zotero catalog</strong>
              <p className={styles.hint}>
                {catalog.total} papers in scope · {catalog.importable} with a
                stored PDF · {catalog.imported} imported
              </p>
            </div>
            <div className={styles.catalogSearch}>
              <input
                className={styles.input}
                type="search"
                value={catalogQuery}
                onChange={(event) => setCatalogQuery(event.target.value)}
                placeholder="Search Zotero metadata"
                onKeyDown={(event) => {
                  if (event.key === "Enter") void loadCatalog(catalogQuery, 1);
                }}
              />
              <button
                type="button"
                className={styles.secondary}
                onClick={() => void loadCatalog(catalogQuery, 1)}
              >
                Search
              </button>
            </div>
          </div>
          <div className={styles.catalogList}>
            {catalog.items.map((item) => (
              <div key={item.key} className={styles.catalogItem}>
                <div>
                  <strong>{item.title}</strong>
                  <p className={styles.hint}>
                    {[item.authors.join(", "), item.year]
                      .filter(Boolean)
                      .join(" · ") || "Metadata only"}
                    {item.annotationCount > 0
                      ? ` · ${item.annotationCount} annotation${item.annotationCount === 1 ? "" : "s"}`
                      : ""}
                  </p>
                </div>
                {item.imported ? (
                  <a
                    className={styles.secondary}
                    href={`/paper/${item.imported.topic}/${item.imported.slug}`}
                  >
                    Open
                  </a>
                ) : (
                  <button
                    type="button"
                    className={styles.save}
                    disabled={!item.hasStoredPdf || importingKey !== null}
                    onClick={() => void importItem(item)}
                    title={
                      item.hasStoredPdf
                        ? "Download this PDF and run AI analysis"
                        : "No stored Zotero PDF is available"
                    }
                  >
                    {importingKey === item.key ? "Importing…" : "Import"}
                  </button>
                )}
              </div>
            ))}
            {catalog.items.length === 0 && (
              <p className={styles.hint}>
                Refresh the catalog, or adjust the current search and collection
                filters.
              </p>
            )}
          </div>
          {catalog.total > catalog.limit && (
            <div className={styles.catalogPagination}>
              <button
                type="button"
                className={styles.secondary}
                disabled={catalog.page <= 1}
                onClick={() => void loadCatalog(catalogQuery, catalog.page - 1)}
              >
                Previous
              </button>
              <span className={styles.hint}>
                Page {catalog.page} of{" "}
                {Math.max(1, Math.ceil(catalog.total / catalog.limit))}
              </span>
              <button
                type="button"
                className={styles.secondary}
                disabled={catalog.page * catalog.limit >= catalog.total}
                onClick={() => void loadCatalog(catalogQuery, catalog.page + 1)}
              >
                Next
              </button>
            </div>
          )}
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
