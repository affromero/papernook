"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import styles from "./AccountBar.module.css";

/**
 * Netflix-style account control: the round avatar sits top-right; clicking
 * it opens the menu (Settings, Switch profile, Log out). Switching is free,
 * the session already proves the access password; logging out closes the
 * gate so the next visitor needs the password again.
 */

interface AccountBarProps {
  displayName: string;
  avatarSlug: string;
}

export function AccountBar({ displayName, avatarSlug }: AccountBarProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  async function logout(): Promise<void> {
    await fetch("/api/v1/session", {
      method: "DELETE",
      credentials: "include",
    });
    router.push("/login");
    router.refresh();
  }

  return (
    <div className={styles.root} ref={rootRef}>
      <span className={styles.brand}>papernook</span>
      <button
        type="button"
        className={styles.avatarBtn}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="account-options"
        aria-label={`Account menu for ${displayName}`}
      >
        <Image
          src={`/avatars/${avatarSlug}.png`}
          alt=""
          width={40}
          height={40}
          className={styles.avatar}
        />
      </button>
      {open && (
        <div
          className={styles.menu}
          id="account-options"
          aria-label="Account options"
        >
          <p className={styles.menuWho}>
            <Image
              src={`/avatars/${avatarSlug}.png`}
              alt=""
              width={28}
              height={28}
              className={styles.avatar}
            />
            {displayName}
          </p>
          <Link href="/graph" onClick={() => setOpen(false)}>
            Graph
          </Link>
          <Link href="/settings" onClick={() => setOpen(false)}>
            Settings
          </Link>
          <Link href="/login" onClick={() => setOpen(false)}>
            Switch profile
          </Link>
          <button type="button" onClick={() => void logout()}>
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
