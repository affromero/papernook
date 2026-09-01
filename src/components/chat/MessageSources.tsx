"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { externalLinkProps } from "@/lib/external-link";
import {
  collectSources,
  pendingLookupUrls,
  type Source,
  type SourceKind,
} from "@/lib/chat/message-sources";
import { AddToLibraryButton } from "@/components/library/AddToLibraryButton";
import styles from "./MessageSources.module.css";

/**
 * Quiet footer under a finished assistant answer listing the external works
 * it linked: badge, title, host — and for papers (arXiv / DOI) whether they
 * are already in the library or one tap away from the inbox. Everything the
 * model wrote is untrusted: titles render as text, links get the same
 * hardened attributes as the Markdown body.
 */

interface LibraryMatch {
  topic: string;
  slug: string;
  title: string;
}

const BADGE: Record<SourceKind, string> = {
  arxiv: "arXiv",
  doi: "DOI",
  github: "GitHub",
  web: "Web",
};

/**
 * Outcome of one library lookup. `unavailable` is a check that did not
 * complete (rate limited, signed out, network): the row must not pretend
 * the paper is absent and offer to capture it again.
 */
type Lookup =
  | { status: "found"; match: LibraryMatch }
  | { status: "absent" }
  | { status: "unavailable" };

/**
 * Per-URL library lookups are shared by every card that mentions the URL.
 * Only a real answer stays cached: a failed batch evicts its URLs so the
 * next card (or a remount) asks again instead of freezing the rows for the
 * session.
 */
const lookups = new Map<string, Promise<Lookup>>();

/** The route caps a batch at twenty URLs; a longer card sends several. */
const BATCH_LIMIT = 20;

/**
 * One POST answers every URL of the batch positionally. The batch promise
 * is seeded into the cache up front so a second card mounting mid-flight
 * awaits it instead of re-asking; a settled answer is pinned as resolved,
 * a failure evicts so retry semantics survive.
 */
function batchLookup(urls: string[]): Promise<Map<string, Lookup>> {
  const batch = fetch("/api/v1/citations/match", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ urls }),
  })
    .then(async (response) => {
      if (!response.ok) throw new Error(`lookup ${response.status}`);
      const data = (await response.json()) as {
        matches?: (LibraryMatch | null)[];
      };
      const results = new Map<string, Lookup>();
      urls.forEach((url, index) => {
        const match = data.matches?.[index] ?? null;
        const lookup: Lookup = match
          ? { status: "found", match }
          : { status: "absent" };
        results.set(url, lookup);
        lookups.set(url, Promise.resolve(lookup));
      });
      return results;
    })
    .catch(() => {
      const results = new Map<string, Lookup>();
      for (const url of urls) {
        lookups.delete(url);
        results.set(url, { status: "unavailable" });
      }
      return results;
    });
  for (const url of urls) {
    lookups.set(
      url,
      batch.then((results) => results.get(url) ?? { status: "unavailable" }),
    );
  }
  return batch;
}

/**
 * `undefined` per URL until the card has scrolled into view and the batch
 * has answered: a long chat with dozens of sourced answers would otherwise
 * spend the shared match budget on rows nobody has looked at yet.
 */
function useLibraryLookups(
  sources: readonly Source[],
  visible: boolean,
): ReadonlyMap<string, Lookup> {
  const [byUrl, setByUrl] = useState<ReadonlyMap<string, Lookup>>(
    () => new Map(),
  );
  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    const apply = (results: ReadonlyMap<string, Lookup>): void => {
      if (disposed || results.size === 0) return;
      setByUrl((previous) => {
        const next = new Map(previous);
        for (const [url, lookup] of results) next.set(url, lookup);
        return next;
      });
    };
    // Snapshot pending before touching the cache: everything already cached
    // (settled or another card's in-flight batch) is awaited as-is.
    const pending = pendingLookupUrls(sources, new Set(lookups.keys()));
    for (const source of sources) {
      const cached = lookups.get(source.url);
      if (cached) {
        void cached.then((lookup) => apply(new Map([[source.url, lookup]])));
      }
    }
    for (let start = 0; start < pending.length; start += BATCH_LIMIT) {
      void batchLookup(pending.slice(start, start + BATCH_LIMIT)).then(apply);
    }
    return () => {
      disposed = true;
    };
  }, [sources, visible]);
  return byUrl;
}

/** True once the element has entered the viewport; stays true afterwards. */
function useSeen<T extends Element>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  // Without an observer (an old WebView) every card counts as seen at once.
  const [seen, setSeen] = useState(
    () => typeof IntersectionObserver === "undefined",
  );
  useEffect(() => {
    const node = ref.current;
    if (!node || seen) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [seen]);
  return [ref, seen];
}

/** Papers only (arXiv / DOI): library membership, else a one-tap capture. */
function LibraryAction({
  url,
  lookup,
}: {
  url: string;
  lookup: Lookup | undefined;
}) {
  if (lookup === undefined) {
    return <span className={styles.checking}>Checking library…</span>;
  }
  if (lookup.status === "unavailable") {
    return (
      <span
        className={styles.checking}
        title="The library check did not complete; reload to try again."
      >
        Library check unavailable
      </span>
    );
  }
  if (lookup.status === "found") {
    const { match } = lookup;
    return (
      <a
        className={styles.inLibrary}
        href={`/paper/${encodeURIComponent(match.topic)}/${encodeURIComponent(match.slug)}`}
        title={match.title}
      >
        In your library →
      </a>
    );
  }
  return <AddToLibraryButton url={url} />;
}

function isPaperLink(source: Source): boolean {
  return source.kind === "arxiv" || source.kind === "doi";
}

export function MessageSources({
  content,
  currentOrigin,
  paperSourceUrl,
}: {
  content: string;
  currentOrigin: string;
  paperSourceUrl?: string;
}) {
  const sources = useMemo(
    () =>
      collectSources(content, paperSourceUrl).filter(
        (source) => "target" in externalLinkProps(source.url, currentOrigin),
      ),
    [content, paperSourceUrl, currentOrigin],
  );
  const [rootRef, seen] = useSeen<HTMLElement>();
  const lookupByUrl = useLibraryLookups(sources, seen);
  if (sources.length === 0) return null;
  return (
    <aside
      ref={rootRef}
      className={styles.root}
      aria-label="Sources and related work"
    >
      <p className={styles.eyebrow}>Sources &amp; related work</p>
      <ul className={styles.list}>
        {sources.map((source) => (
          <li key={source.url} className={styles.item}>
            <span className={styles.badge} data-kind={source.kind}>
              {BADGE[source.kind]}
            </span>
            <span className={styles.body}>
              <a
                className={styles.title}
                href={source.url}
                {...externalLinkProps(source.url, currentOrigin, true)}
              >
                {source.title}
              </a>
              <span className={styles.host}>{source.host}</span>
            </span>
            {isPaperLink(source) && (
              <span className={styles.action}>
                <LibraryAction
                  url={source.url}
                  lookup={lookupByUrl.get(source.url)}
                />
              </span>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
