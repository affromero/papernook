"use client";

import { useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Plus, Check, X } from "lucide-react";
import { ANIMAL_AVATARS } from "@/lib/avatars";
import styles from "./ProfilePicker.module.css";

export interface PickerProfile {
  username: string;
  displayName: string;
  avatarSlug: string;
  hasPassword: boolean;
}

interface ProfilePickerProps {
  profiles: PickerProfile[];
  /** True when the instance requires passwords (public exposure). */
  publicMode: boolean;
}

type Editor =
  | { mode: "create" }
  | { mode: "password"; profile: PickerProfile; mustSet: boolean }
  | null;

export function ProfilePicker({ profiles, publicMode }: ProfilePickerProps) {
  const router = useRouter();
  const [editor, setEditor] = useState<Editor>(null);
  const [name, setName] = useState("");
  const [avatarSlug, setAvatarSlug] = useState(ANIMAL_AVATARS[0].slug);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function login(
    username: string,
    pw?: string,
    newPw?: string,
  ): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username, password: pw, newPassword: newPw }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        mustSetPassword?: boolean;
      };
      if (!res.ok) {
        if (body.mustSetPassword) {
          const profile = profiles.find((p) => p.username === username);
          if (profile) {
            setPassword("");
            setEditor({ mode: "password", profile, mustSet: true });
            setBusy(false);
            return;
          }
        }
        throw new Error(body.error ?? "Could not sign in.");
      }
      router.push("/");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not sign in.");
      setBusy(false);
    }
  }

  function pick(profile: PickerProfile): void {
    if (busy) return;
    if (publicMode) {
      setPassword("");
      setEditor({ mode: "password", profile, mustSet: !profile.hasPassword });
      return;
    }
    void login(profile.username);
  }

  async function saveCreate(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ displayName: name.trim(), avatarSlug }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        profile?: { username: string };
      };
      if (!res.ok || !body.profile)
        throw new Error(body.error ?? "Could not create the profile.");
      setBusy(false);
      if (publicMode) {
        setPassword("");
        setEditor({
          mode: "password",
          profile: {
            username: body.profile.username,
            displayName: name.trim(),
            avatarSlug,
            hasPassword: false,
          },
          mustSet: true,
        });
        return;
      }
      await login(body.profile.username);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not create the profile.",
      );
      setBusy(false);
    }
  }

  function closeEditor(): void {
    setEditor(null);
    setError(null);
  }

  if (editor?.mode === "password") {
    const { profile, mustSet } = editor;
    return (
      <div className={styles.root}>
        <div className={styles.brand}>papernook</div>
        <div
          className={styles.panel}
          role="dialog"
          aria-modal="true"
          aria-label={mustSet ? "Set a password" : "Enter password"}
        >
          <h1 className={styles.panelTitle}>
            {mustSet
              ? `Set a password for ${profile.displayName}`
              : `Hi ${profile.displayName}`}
          </h1>
          <label className={styles.fieldLabel} htmlFor="profile-password">
            {mustSet ? "New password (min 8 characters)" : "Password"}
          </label>
          <input
            id="profile-password"
            className={styles.nameInput}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            maxLength={200}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && password.length > 0) {
                void login(
                  profile.username,
                  mustSet ? undefined : password,
                  mustSet ? password : undefined,
                );
              }
            }}
          />
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <div className={styles.panelActions}>
            <button
              type="button"
              className={styles.ghostBtn}
              onClick={closeEditor}
              disabled={busy}
            >
              <X size={16} aria-hidden="true" /> Cancel
            </button>
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={() =>
                login(
                  profile.username,
                  mustSet ? undefined : password,
                  mustSet ? password : undefined,
                )
              }
              disabled={busy || password.length === 0}
            >
              <Check size={16} aria-hidden="true" />{" "}
              {mustSet ? "Set & enter" : "Enter"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (editor?.mode === "create") {
    return (
      <div className={styles.root}>
        <div className={styles.brand}>papernook</div>
        <div
          className={styles.panel}
          role="dialog"
          aria-modal="true"
          aria-label="Add a profile"
        >
          <h1 className={styles.panelTitle}>Add a profile</h1>
          <label className={styles.fieldLabel} htmlFor="profile-name">
            Name
          </label>
          <input
            id="profile-name"
            className={styles.nameInput}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            placeholder="e.g. Andres"
            autoFocus
          />
          <span className={styles.fieldLabel}>Avatar</span>
          <div
            className={styles.animalGrid}
            role="radiogroup"
            aria-label="Choose an avatar"
          >
            {ANIMAL_AVATARS.map((a) => {
              const selected = a.slug === avatarSlug;
              return (
                <button
                  key={a.slug}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={a.name}
                  className={`${styles.animalTile} ${selected ? styles.animalTileSelected : ""}`}
                  onClick={() => setAvatarSlug(a.slug)}
                >
                  <Image
                    src={`/avatars/${a.slug}.png`}
                    alt=""
                    width={64}
                    height={64}
                  />
                </button>
              );
            })}
          </div>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <div className={styles.panelActions}>
            <button
              type="button"
              className={styles.ghostBtn}
              onClick={closeEditor}
              disabled={busy}
            >
              <X size={16} aria-hidden="true" /> Cancel
            </button>
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={() => void saveCreate()}
              disabled={busy || name.trim().length < 2}
            >
              <Check size={16} aria-hidden="true" /> Create
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.brand}>papernook</div>
      <h1 className={styles.heading}>Who&rsquo;s reading?</h1>
      <p className={styles.sub}>
        self hosted · {profiles.length}{" "}
        {profiles.length === 1 ? "profile" : "profiles"} on this server
      </p>
      <div className={styles.row}>
        {profiles.map((p) => (
          <button
            key={p.username}
            type="button"
            className={styles.profile}
            onClick={() => pick(p)}
            disabled={busy}
            aria-label={`Switch to ${p.displayName}`}
          >
            <span className={styles.avatar}>
              <Image
                src={`/avatars/${p.avatarSlug}.png`}
                alt=""
                fill
                sizes="140px"
              />
            </span>
            <span className={styles.name}>{p.displayName}</span>
          </button>
        ))}
        <button
          type="button"
          className={`${styles.profile} ${styles.add}`}
          onClick={() => {
            setName("");
            setAvatarSlug(ANIMAL_AVATARS[0].slug);
            setError(null);
            setEditor({ mode: "create" });
          }}
          disabled={busy}
        >
          <span className={`${styles.avatar} ${styles.addAvatar}`}>
            <Plus size={40} aria-hidden="true" />
          </span>
          <span className={styles.name}>Add profile</span>
        </button>
      </div>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
