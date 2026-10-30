"use client";
import { Tldraw, loadSnapshot } from "tldraw";
import "tldraw/tldraw.css";
import styles from "./StudyArtifacts.module.css";

export function SharedCanvas({
  document,
  licenseKey,
}: {
  document: unknown;
  licenseKey: string | null;
}) {
  return (
    <div className={styles.canvas} aria-label="View-only canvas">
      <Tldraw
        hideUi
        licenseKey={licenseKey ?? undefined}
        onMount={(editor) => {
          loadSnapshot(editor.store, { document } as never);
          editor.updateInstanceState({ isReadonly: true });
          editor.zoomToFit();
        }}
      />
    </div>
  );
}
