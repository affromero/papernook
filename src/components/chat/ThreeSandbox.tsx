"use client";

import styles from "./ThreeSandbox.module.css";

/**
 * URL of the static sandbox host page with the scene code in the fragment.
 * A real /vendor/ URL (not srcdoc) so the document escapes the app's
 * nonce CSP, which srcdoc would inherit and which would block the
 * injected module script. The fragment never reaches the server.
 */
export function threeSandboxUrl(code: string): string {
  return `/vendor/three-sandbox.html#${encodeURIComponent(code)}`;
}

/**
 * Interactive viewer for AI-emitted ```threejs blocks. sandbox stays
 * exactly "allow-scripts" — never allow-same-origin: the code is
 * AI-authored and thus influenced by web-downloaded paper text, so
 * opaque-origin isolation is the containment boundary.
 */
export function ThreeSandbox({ code }: { code: string }) {
  return (
    <iframe
      className={styles.frame}
      sandbox="allow-scripts"
      src={threeSandboxUrl(code)}
      title="Interactive 3D scene"
      loading="lazy"
    />
  );
}
