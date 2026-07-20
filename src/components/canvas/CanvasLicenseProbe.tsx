"use client";

import { useEffect, useRef } from "react";
import { Tldraw } from "tldraw";
import "tldraw/tldraw.css";
import styles from "./CanvasLicenseProbe.module.css";

interface CanvasLicenseProbeProps {
  licenseKey: string;
  onResult: (valid: boolean) => void;
}

const VALIDATION_WINDOW_MS = 6_500;

export function CanvasLicenseProbe({
  licenseKey,
  onResult,
}: CanvasLicenseProbeProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let settled = false;
    const finish = (valid: boolean) => {
      if (settled) return;
      settled = true;
      onResult(valid);
    };
    const detectRejection = () => {
      if (root.querySelector('[data-testid="tl-license-expired"]')) {
        finish(false);
      }
    };
    const observer = new MutationObserver(detectRejection);
    observer.observe(root, { childList: true, subtree: true });
    detectRejection();
    const timer = window.setTimeout(() => finish(true), VALIDATION_WINDOW_MS);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [licenseKey, onResult]);

  return (
    <div ref={rootRef} className={styles.probe} aria-hidden="true">
      <Tldraw licenseKey={licenseKey} />
    </div>
  );
}
