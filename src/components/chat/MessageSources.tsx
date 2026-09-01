"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { externalLinkProps } from "@/lib/external-link";
import {
  collectSources,
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
 * Only a real answer stays cached: an unavailable result is evicted so the
 * next mount asks again instead of freezing the row for the session.
 */
const lookups = new Map<string, Promise<Lookup>>();

function lookupLibrary(url: string): Promise<Lookup> {
  let pending = lookups.get(url);
  if (!pending) {
    pending = fetch(`/api/v1/citations/match?url=${encodeURIComponent(url)}`, {
      credentials: "same-origin",
    })
      .then(async (response): Promise<Lookup> => {
        if (!response.ok) throw new Error(`lookup ${response.status}`);
        const data = (await response.json()) as {
          match?: LibraryMatch | null;
        };
        return data.match
          ? { status: "found", match: data.match }
          : { status: "absent" };
      })
      .catch((): Lookup => {
        lookups.delete(url);
        return { status: "unavailable" };
      });
    lookups.set(url, pending);
  }
  return pending;
}

/**
 * `undefined` until the card has scrolled into view and the lookup has
 * answered: a long chat with dozens of sourced answers would otherwise
 * spend the shared match budget on rows nobody has looked at yet. The row
 * is keyed by URL, so a different source mounts a fresh instance.
 */
function useLibraryLookup(url: string, visible: boolean): Lookup | undefined {
  const [lookup, setLookup] = useState<Lookup | undefined>(undefined);
  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    lookupLibrary(url).then((found) => {
      if (!disposed) setLookup(found);
    });
    return () => {
      disposed = true;
    };
  }, [url, visible]);
  return lookup;
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
function LibraryAction({ url, visible }: { url: string; visible: boolean }) {
  const lookup = useLibraryLookup(url, visible);
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
                <LibraryAction url={source.url} visible={seen} />
              </span>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
