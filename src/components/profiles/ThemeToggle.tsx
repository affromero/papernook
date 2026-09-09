"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";
import styles from "./ThemeToggle.module.css";

type ThemePreference = "system" | "light" | "dark";
const THEME_KEY = "papernook:theme";

function preference(value: string | null | undefined): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

function currentPreference(): ThemePreference {
  const selected = document.documentElement.dataset.themePreference;
  if (selected) return preference(selected);
  try {
    return preference(window.localStorage.getItem(THEME_KEY));
  } catch {
    return "system";
  }
}

function applyPreference(selected: ThemePreference, persist: boolean): void {
  const theme =
    selected === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : selected;
  document.documentElement.dataset.themePreference = selected;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  if (persist) {
    try {
      if (selected === "system") window.localStorage.removeItem(THEME_KEY);
      else window.localStorage.setItem(THEME_KEY, selected);
    } catch {}
  }
  window.dispatchEvent(new Event("papernook:theme-changed"));
}

function subscribe(onStoreChange: () => void): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const followSystem = () => {
    if (currentPreference() === "system") applyPreference("system", false);
  };
  const followSavedTheme = (event: StorageEvent) => {
    if (event.key !== THEME_KEY && event.key !== null) return;
    try {
      if (event.storageArea !== window.localStorage) return;
    } catch {
      return;
    }
    applyPreference(preference(event.newValue), false);
  };
  window.addEventListener("papernook:theme-changed", onStoreChange);
  window.addEventListener("storage", followSavedTheme);
  media.addEventListener("change", followSystem);
  applyPreference(currentPreference(), false);
  return () => {
    window.removeEventListener("papernook:theme-changed", onStoreChange);
    window.removeEventListener("storage", followSavedTheme);
    media.removeEventListener("change", followSystem);
  };
}

export function ThemeToggle() {
  const selected = useSyncExternalStore(
    subscribe,
    currentPreference,
    () => "system",
  );
  const Icon =
    selected === "system" ? Monitor : selected === "dark" ? Moon : Sun;
  return (
    <label className={styles.toggle} title={`Color theme: ${selected}`}>
      <Icon aria-hidden="true" size={18} strokeWidth={1.8} />
      <select
        className={styles.select}
        aria-label="Color theme"
        value={selected}
        onChange={(event) =>
          applyPreference(preference(event.target.value), true)
        }
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
