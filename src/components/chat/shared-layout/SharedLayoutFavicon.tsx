"use client";

import { useState } from "react";
import Image from "next/image";
import { Globe } from "lucide-react";
import styles from "./SharedLayout.module.css";

export function SharedLayoutFavicon({
  origin,
  host,
  size,
}: {
  origin: string;
  host: string;
  size: string;
}) {
  const [status, setStatus] = useState<"idle" | "loading" | "loaded" | "error">(
    "idle",
  );
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
          : `Load site icon for ${host}`;
  return (
    <button
      type="button"
      className={styles.favicon}
      data-share-favicon-size={size}
      title={status === "error" ? `Site icon unavailable. ${label}` : label}
      aria-label={label}
      disabled={status === "loading" || status === "loaded"}
      onClick={() => setStatus("loading")}
    >
      {status === "loading" || status === "loaded" ? (
        <Image
          src={`/api/v1/site-icon?url=${encodeURIComponent(origin)}`}
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
      ) : (
        <Globe aria-hidden="true" />
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
