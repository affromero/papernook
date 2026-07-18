"use client";

import { useEffect } from "react";
import { registerServiceWorker } from "thesidedoor/pwa";

/** Registers sidedoor's network-first service worker (copied to /sw.js). */
export function PwaSetup() {
  useEffect(() => {
    void registerServiceWorker();
  }, []);
  return null;
}
