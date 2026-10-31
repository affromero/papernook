"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Globe } from "lucide-react";
import styles from "./SharedLayout.module.css";
import { requestSiteIcon } from "./site-icon-queue";

export function SharedLayoutFavicon({
  origin,
  host,
  size,
  automatic = false,
}: {
  origin: string;
  host: string;
  size: string;
  automatic?: boolean;
}) {
  const [status, setStatus] = useState<"idle" | "loading" | "loaded" | "error">(
    "idle",
  );
  const [source, setSource] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [requested, setRequested] = useState(false);
  const enabled = automatic || requested;
  const root = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!enabled || !origin || !root.current) return;
    let subscribed: ReturnType<typeof requestSiteIcon> | undefined;
    let mounted = true;
    function load(): void {
      if (subscribed) return;
      subscribed = requestSiteIcon(origin);
      setStatus("loading");
      void subscribed.result.then(
        (value) => {
          if (mounted) setSource(value);
        },
        () => {
          if (mounted) setStatus("error");
        },
      );
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          load();
        }
      },
      { rootMargin: "160px" },
    );
    observer.observe(root.current);
    return () => {
      mounted = false;
      observer.disconnect();
      subscribed?.cancel();
    };
  }, [origin, attempt, enabled]);
  if (!origin)
    return (
      <span
        className={styles.favicon}
        data-share-favicon-size={size}
        role="img"
        aria-label="Site icon unavailable"
        title="Site icon unavailable"
      >
        <Globe aria-hidden="true" />
      </span>
    );
  const label =
    status === "error"
      ? `Retry site icon for ${host}`
      : status === "loading"
        ? `Loading site icon for ${host}`
        : status === "loaded"
          ? `Site icon for ${host}`
          : enabled
            ? `Loading site icon for ${host}`
            : `Load site icon for ${host}`;
  return (
    <button
      ref={root}
      type="button"
      className={styles.favicon}
      data-share-favicon-size={size}
      data-state={status}
      title={status === "error" ? `Site icon unavailable. ${label}` : label}
      aria-label={label}
      disabled={status !== "error" && enabled}
      onClick={() => {
        setSource("");
        setRequested(true);
        setStatus("idle");
        setAttempt((value) => value + 1);
      }}
    >
      <Globe aria-hidden="true" />
      {source && (
        <Image
          key={attempt}
          className={styles.faviconImage}
          src={source}
          alt=""
          width={Number(size)}
          height={Number(size)}
          unoptimized
          loading="eager"
          referrerPolicy="no-referrer"
          onLoad={(event) =>
            setStatus(event.currentTarget.naturalWidth > 0 ? "loaded" : "error")
          }
          onError={() => setStatus("error")}
        />
      )}
      {status === "error" && (
        <span
          className={styles.faviconError}
          role="status"
          aria-label="Site icon could not be loaded"
        >
          !
        </span>
      )}
    </button>
  );
}
