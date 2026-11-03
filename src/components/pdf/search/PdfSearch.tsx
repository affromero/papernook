"use client";

import { Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ViewerEventBus } from "../useCitationHotspots";
import styles from "../PdfReader.module.css";

export function PdfSearch({
  eventBus,
  shortcut,
}: {
  eventBus: ViewerEventBus | null;
  shortcut: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [count, setCount] = useState({ current: 0, total: 0 });
  const [notFound, setNotFound] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!shortcut) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault();
        setOpen(true);
        window.requestAnimationFrame(() => input.current?.focus());
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shortcut]);

  useEffect(() => {
    if (!eventBus) return;
    const update = (event: unknown) => {
      if (!event || typeof event !== "object") return;
      if (
        "matchesCount" in event &&
        event.matchesCount &&
        typeof event.matchesCount === "object" &&
        "current" in event.matchesCount &&
        "total" in event.matchesCount &&
        typeof event.matchesCount.current === "number" &&
        typeof event.matchesCount.total === "number"
      ) {
        setCount({
          current: event.matchesCount.current,
          total: event.matchesCount.total,
        });
      }
      if ("state" in event && typeof event.state === "number")
        setNotFound(event.state === 1);
    };
    eventBus.on("updatefindmatchescount", update);
    eventBus.on("updatefindcontrolstate", update);
    return () => {
      eventBus.off("updatefindmatchescount", update);
      eventBus.off("updatefindcontrolstate", update);
    };
  }, [eventBus]);

  function find(value: string, previous = false, again = false) {
    setNotFound(false);
    eventBus?.dispatch("find", {
      source: null,
      type: again ? "again" : "",
      query: value,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: previous,
      matchDiacritics: false,
    });
  }

  function close() {
    setOpen(false);
    setQuery("");
    setCount({ current: 0, total: 0 });
    setNotFound(false);
    eventBus?.dispatch("findbarclose", { source: null });
  }

  return (
    <>
      <button
        type="button"
        aria-label="Search paper"
        title="Search paper"
        onClick={() => {
          setOpen(true);
          window.requestAnimationFrame(() => input.current?.focus());
        }}
      >
        <Search aria-hidden="true" />
      </button>
      {open && (
        <div className={styles.findBar} role="search" aria-label="Search paper">
          <input
            ref={input}
            type="search"
            aria-label="Find in paper"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              find(event.target.value);
            }}
            onKeyDown={(event) => {
              if (
                ["backspace", "delete", "a", "z", "y"].includes(
                  event.key.toLowerCase(),
                )
              ) {
                event.stopPropagation();
              }
              if (event.key === "Enter") {
                event.preventDefault();
                find(query, event.shiftKey, true);
              } else if (event.key === "Escape") {
                event.preventDefault();
                close();
              }
            }}
          />
          <span role="status">
            {query
              ? notFound
                ? "No matches"
                : `${count.current} of ${count.total}`
              : ""}
          </span>
          <button
            type="button"
            aria-label="Previous match"
            onClick={() => find(query, true, true)}
          >
            ↑
          </button>
          <button
            type="button"
            aria-label="Next match"
            onClick={() => find(query, false, true)}
          >
            ↓
          </button>
          <button type="button" aria-label="Close paper search" onClick={close}>
            <X aria-hidden="true" />
          </button>
        </div>
      )}
    </>
  );
}
