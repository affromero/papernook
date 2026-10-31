"use client";

import {
  useEffect,
  useCallback,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
} from "react";
import { ArrowUpRight, Check, Copy } from "lucide-react";
import { SharedLayoutFavicon } from "../shared-layout/SharedLayoutFavicon";
import styles from "./ExternalLinkPreview.module.css";

export function ExternalLinkPreview({
  href,
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<"a"> & { href: string }) {
  const root = useRef<HTMLSpanElement>(null);
  const card = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const restoringFocus = useRef(false);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"idle" | "copied" | "error">("idle");
  const destination = new URL(href.startsWith("//") ? `https:${href}` : href);

  const close = useCallback((): void => {
    clearTimeout(timer.current);
    restoringFocus.current = true;
    if (
      typeof card.current?.showPopover === "function" &&
      card.current.matches(":popover-open")
    )
      card.current.hidePopover();
    setOpen(false);
    queueMicrotask(() => {
      restoringFocus.current = false;
    });
  }, []);

  function show(): void {
    if (restoringFocus.current) return;
    clearTimeout(timer.current);
    if (!open) setCopied("idle");
    setOpen(true);
    if (
      CSS.supports("anchor-name", "--destination-link") &&
      CSS.supports("anchor-scope", "--destination-link") &&
      typeof card.current?.showPopover === "function" &&
      !card.current?.matches(":popover-open")
    )
      card.current?.showPopover();
  }

  function leave(): void {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!root.current?.matches(":focus-within")) close();
    }, 180);
  }

  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent): void {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        close();
    }
    document.addEventListener("pointerdown", outside);
    return () => {
      clearTimeout(timer.current);
      document.removeEventListener("pointerdown", outside);
    };
  }, [open, close]);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(destination.href);
      setCopied("copied");
    } catch {
      setCopied("error");
    }
  }

  return (
    <span
      ref={root}
      className={styles.wrapper}
      onPointerEnter={show}
      onPointerLeave={leave}
      onFocus={show}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
    >
      <a {...props} href={href} className={`${styles.link} ${className ?? ""}`}>
        {children}
        <ArrowUpRight aria-hidden="true" className={styles.arrow} />
      </a>
      <span
        ref={card}
        popover="auto"
        className={styles.card}
        data-open={open}
        role="dialog"
        aria-label={`Link to ${destination.hostname}`}
        onToggle={(event) => {
          if (!event.currentTarget.matches(":popover-open")) setOpen(false);
        }}
      >
        {open && (
          <>
            {destination.protocol === "https:" && (
              <SharedLayoutFavicon
                key={destination.origin}
                origin={destination.origin}
                host={destination.hostname}
                size="24"
                automatic
              />
            )}
            <a
              href={destination.href}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className={styles.address}
            >
              <span>{destination.hostname}</span>
              <span>{destination.href}</span>
            </a>
            <button
              type="button"
              className={styles.copy}
              aria-label={
                copied === "copied" ? "Copy link URL (copied)" : "Copy link URL"
              }
              title={copied === "copied" ? "Link copied" : "Copy link URL"}
              onClick={() => void copy()}
            >
              {copied === "copied" ? <Check /> : <Copy />}
            </button>
            {copied === "error" && (
              <span role="alert">Could not copy the link. Try again.</span>
            )}
          </>
        )}
      </span>
    </span>
  );
}
