"use client";

import { Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";
import styles from "./ThemeToggle.module.css";

type Theme = "light" | "dark";

const THEME_KEY = "papernook:theme";

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function applyTheme(theme: Theme, persist: boolean): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  if (persist) window.localStorage.setItem(THEME_KEY, theme);
  window.dispatchEvent(new Event("papernook:theme-changed"));
}

function subscribe(onStoreChange: () => void): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const followSystem = (event: MediaQueryListEvent) => {
    if (window.localStorage.getItem(THEME_KEY)) return;
    applyTheme(event.matches ? "dark" : "light", false);
  };
  const followSavedTheme = (event: StorageEvent) => {
    if (event.key !== THEME_KEY) return;
    const saved = event.newValue;
    if (saved === "light" || saved === "dark") {
      applyTheme(saved, false);
      return;
    }
    applyTheme(media.matches ? "dark" : "light", false);
  };
  window.addEventListener("papernook:theme-changed", onStoreChange);
  window.addEventListener("storage", followSavedTheme);
  media.addEventListener("change", followSystem);
  return () => {
    window.removeEventListener("papernook:theme-changed", onStoreChange);
    window.removeEventListener("storage", followSavedTheme);
    media.removeEventListener("change", followSystem);
  };
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => "light");
  const nextTheme = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className={styles.toggle}
      aria-label={`Use ${nextTheme} theme`}
      title={`Use ${nextTheme} theme`}
      onClick={() => applyTheme(nextTheme, true)}
    >
      {theme === "dark" ? (
        <Sun aria-hidden="true" size={18} strokeWidth={1.8} />
      ) : (
        <Moon aria-hidden="true" size={18} strokeWidth={1.8} />
      )}
    </button>
  );
}
