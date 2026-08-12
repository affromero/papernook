"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ANIMAL_AVATARS } from "@/lib/auth/avatars";
import styles from "./AvatarPicker.module.css";

interface AvatarPickerProps {
  username: string;
  avatarSlug: string;
}

export function AvatarPicker({ username, avatarSlug }: AvatarPickerProps) {
  const router = useRouter();
  const [savedSlug, setSavedSlug] = useState(avatarSlug);
  const [selectedSlug, setSelectedSlug] = useState(avatarSlug);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);

  async function save(): Promise<void> {
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/v1/profiles/${username}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ avatarSlug: selectedSlug }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        setFeedback({
          tone: "error",
          message: data.error ?? "Could not save the avatar.",
        });
        return;
      }
      setSavedSlug(selectedSlug);
      setFeedback({ tone: "success", message: "Avatar saved." });
      router.refresh();
    } catch {
      setFeedback({
        tone: "error",
        message: "Could not save the avatar. Check the server connection.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.root}>
      <div
        className={styles.options}
        role="radiogroup"
        aria-label="Choose your avatar"
      >
        {ANIMAL_AVATARS.map((avatar) => {
          const selected = avatar.slug === selectedSlug;
          return (
            <button
              key={avatar.slug}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={avatar.name}
              className={`${styles.option} ${selected ? styles.optionSelected : ""}`}
              onClick={() => {
                setSelectedSlug(avatar.slug);
                setFeedback(null);
              }}
              disabled={busy}
            >
              <Image
                src={`/avatars/${avatar.slug}.png`}
                alt=""
                width={64}
                height={64}
              />
              <span>{avatar.name}</span>
            </button>
          );
        })}
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.save}
          onClick={() => void save()}
          disabled={busy || selectedSlug === savedSlug}
        >
          {busy ? "Saving…" : "Save avatar"}
        </button>
        {feedback && (
          <p
            className={
              feedback.tone === "error" ? styles.error : styles.success
            }
            role={feedback.tone === "error" ? "alert" : "status"}
          >
            {feedback.message}
          </p>
        )}
      </div>
    </div>
  );
}
