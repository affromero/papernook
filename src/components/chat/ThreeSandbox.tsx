"use client";

import { useEffect, useRef } from "react";
import styles from "./ThreeSandbox.module.css";

const SANDBOX_VERSION = 2;
const DIAGNOSTIC_KINDS = new Set([
  "bootstrap-decode-failed",
  "module-evaluation-failed",
  "resource-load-failed",
  "unhandled-rejection",
  "console-error",
  "webgl-unavailable",
  "webgl-context-lost",
  "canvas-missing",
]);
const RESOURCE_KINDS = new Set([
  "sandbox",
  "three-module",
  "three-core",
  "three-addon",
  "other-vendor",
]);

interface ThreeDiagnostic {
  protocol: 1;
  type: "papernook-three-diagnostic";
  kind: string;
  line?: number;
  column?: number;
  resource?: string;
}

function isBoundedLocation(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= 10_000_000
  );
}

export function isThreeDiagnostic(value: unknown): value is ThreeDiagnostic {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.some(
      (key) =>
        !["protocol", "type", "kind", "line", "column", "resource"].includes(
          key,
        ),
    )
  ) {
    return false;
  }
  if (
    record.protocol !== 1 ||
    record.type !== "papernook-three-diagnostic" ||
    typeof record.kind !== "string" ||
    !DIAGNOSTIC_KINDS.has(record.kind)
  ) {
    return false;
  }
  if (record.line !== undefined && !isBoundedLocation(record.line))
    return false;
  if (record.column !== undefined && !isBoundedLocation(record.column))
    return false;
  if (
    record.resource !== undefined &&
    (typeof record.resource !== "string" ||
      !RESOURCE_KINDS.has(record.resource))
  ) {
    return false;
  }
  return true;
}

/**
 * URL of the static sandbox host page with the scene code in the fragment.
 * A real /vendor/ URL (not srcdoc) so the document escapes the app's
 * nonce CSP, which srcdoc would inherit and which would block the
 * injected module script. The fragment never reaches the server.
 */
export function threeSandboxUrl(code: string): string {
  return `/vendor/three-sandbox.html?v=${SANDBOX_VERSION}#${encodeURIComponent(code)}`;
}

/**
 * Interactive viewer for AI-emitted ```threejs blocks. sandbox stays
 * exactly "allow-scripts" — never allow-same-origin: the code is
 * AI-authored and thus influenced by web-downloaded paper text, so
 * opaque-origin isolation is the containment boundary.
 */
export function ThreeSandbox({ code }: { code: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const delivered = new Set<string>();
    let deliveredCount = 0;

    const onMessage = (event: MessageEvent<unknown>) => {
      if (
        event.source !== iframe.contentWindow ||
        !isThreeDiagnostic(event.data)
      ) {
        return;
      }
      const fingerprint = JSON.stringify(event.data);
      if (delivered.has(fingerprint) || deliveredCount >= 8) return;
      delivered.add(fingerprint);
      deliveredCount += 1;
      void fetch("/api/v1/client-logs", {
        method: "POST",
        credentials: "include",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: fingerprint,
      }).catch(() => undefined);
    };
    const announceReady = () => {
      iframe.contentWindow?.postMessage(
        "papernook-three-diagnostics-ready",
        "*",
      );
    };

    window.addEventListener("message", onMessage);
    iframe.addEventListener("load", announceReady);
    announceReady();
    return () => {
      window.removeEventListener("message", onMessage);
      iframe.removeEventListener("load", announceReady);
    };
  }, [code]);

  return (
    <iframe
      ref={iframeRef}
      className={styles.frame}
      sandbox="allow-scripts"
      src={threeSandboxUrl(code)}
      title="Interactive 3D scene"
      loading="lazy"
    />
  );
}
