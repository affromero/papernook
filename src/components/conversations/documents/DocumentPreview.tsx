"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ConversationAsset } from "@/lib/conversations/content";
import {
  previewResultSchema,
  type DocumentPreview as Preview,
} from "@/lib/conversations/documents/schema";
import { Markdown } from "@/components/chat/Markdown";
import { RichPreview } from "../RichContent";
import styles from "./DocumentPreview.module.css";

const PdfReader = dynamic(
  () => import("@/components/pdf/PdfReader").then((module) => module.PdfReader),
  { ssr: false },
);

export default function DocumentPreview({
  asset,
  url,
  onClose,
}: {
  asset: ConversationAsset;
  url: string;
  onClose(): void;
}) {
  const [result, setResult] = useState<{
    asset: ConversationAsset;
    url: string;
    document: Preview | null;
    pdfUrl: string;
    error: string;
  } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const current = result?.asset === asset && result.url === url ? result : null;
  const document = current?.document;
  const pdfUrl = current?.pdfUrl;
  const error = current?.error;
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const worker = new Worker(
      new URL(
        "../../../lib/conversations/documents/document.worker.ts",
        import.meta.url,
      ),
      { type: "module" },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      try {
        const response = await fetch(url, {
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error(
            `Attachment could not be loaded (HTTP ${response.status}).`,
          );
        const blob = await response.blob();
        if (blob.size > 20 * 1024 * 1024)
          throw new Error("Attachment exceeds the preview limit.");
        const bytes = await blob.arrayBuffer();
        const result = await new Promise<Preview>((resolve, reject) => {
          timer = setTimeout(() => {
            worker.terminate();
            reject(
              new Error(
                "Document preview took too long. Download the original to open it.",
              ),
            );
          }, 8000);
          worker.onmessage = (event: MessageEvent<unknown>) => {
            try {
              const result = previewResultSchema.parse(event.data);
              if (!result.ok) throw new Error(result.error);
              resolve(result.document);
            } catch (error) {
              reject(error);
            }
          };
          worker.onerror = () =>
            reject(new Error("Document preview could not be processed."));
          worker.postMessage(
            { bytes, name: asset.name, mime: asset.mime ?? "" },
            [bytes],
          );
        });
        if (controller.signal.aborted) return;
        setResult({
          asset,
          url,
          document: result,
          pdfUrl: result.kind === "pdf" ? url : "",
          error: "",
        });
      } catch (error) {
        if (!controller.signal.aborted)
          setResult({
            asset,
            url,
            document: null,
            pdfUrl: "",
            error:
              error instanceof Error
                ? error.message
                : "Document preview failed.",
          });
      } finally {
        clearTimeout(timer);
        worker.terminate();
      }
    })();
    return () => {
      controller.abort();
      clearTimeout(timer);
      worker.terminate();
    };
  }, [asset, url]);
  return createPortal(
    <dialog
      className={styles.root}
      ref={dialog}
      aria-label={`Preview ${asset.name}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className={styles.header}>
        <h3>{asset.name}</h3>
        <button type="button" onClick={onClose}>
          Close preview
        </button>
      </header>
      {!document && !error && <p role="status">Loading document preview…</p>}
      {error && <p role="alert">{error}</p>}
      {document?.kind === "pdf" && pdfUrl && (
        <div className={styles.pdf}>
          <PdfReader
            src={pdfUrl}
            title={asset.name}
            editable={false}
            libraryLookup={false}
            chatPrompts={false}
          />
        </div>
      )}
      {document?.kind === "notebook" && (
        <Markdown
          content={document.content}
          renderArtifacts
          paperRefs={false}
        />
      )}
      {document?.kind === "artifact" && (
        <RichPreview kind={document.format} source={document.content} />
      )}
      {document?.kind === "document" && (
        <>
          {document.notice && <p>{document.notice}</p>}
          {document.sections.map((section, index) => (
            <section key={index}>
              <h4>{section.title}</h4>
              {section.blocks.map((block, index) =>
                block.kind === "text" ? (
                  <p key={index} className={styles.text}>
                    {block.text}
                  </p>
                ) : block.kind === "image" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={index} src={block.source} alt={block.name} />
                ) : (
                  <div className={styles.table} key={index}>
                    <table>
                      <tbody>
                        {block.rows.map((row, index) => (
                          <tr key={index}>
                            {row.map((cell, index) => (
                              <td key={index}>{cell}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ),
              )}
            </section>
          ))}
        </>
      )}
    </dialog>,
    globalThis.document.body,
  );
}
