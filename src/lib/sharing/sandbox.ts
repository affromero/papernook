import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { base64Schema, SharingError } from "./schema";
import type { PdfCommentAction } from "../library/pdf/comments";

export const MAX_COLLABORATIVE_PDF_BYTES = 32 * 1024 * 1024;

/** Parse untrusted PDF object streams outside the web server, with no ambient credentials. */
export async function reconstructAnnotations(
  current: Uint8Array,
  proposed: Uint8Array,
  actor: { id: string; name: string },
  owner = false,
): Promise<Uint8Array> {
  if (proposed.byteLength > MAX_COLLABORATIVE_PDF_BYTES)
    throw new SharingError(
      "Collaborative annotation saves support PDFs up to 32 MB.",
      413,
    );
  return runWorker(current, {
    action: "annotations",
    proposed: Buffer.from(proposed).toString("base64"),
    actor,
    owner,
  });
}

export function reconstructComment(
  current: Uint8Array,
  comment: PdfCommentAction,
  actor: { id: string; name: string },
): Promise<Uint8Array> {
  return runWorker(current, { action: "comment", comment, actor });
}

type WorkerOperation =
  | {
      action: "annotations";
      proposed: string;
      actor: { id: string; name: string };
      owner: boolean;
    }
  | {
      action: "comment";
      comment: PdfCommentAction;
      actor: { id: string; name: string };
    };

async function runWorker(
  current: Uint8Array,
  operation: WorkerOperation,
): Promise<Uint8Array> {
  if (current.byteLength > MAX_COLLABORATIVE_PDF_BYTES)
    throw new SharingError(
      "Collaborative annotation saves support PDFs up to 32 MB.",
      413,
    );
  const runtimeWorker = path.resolve("scripts/sharing-worker.cjs");
  const worker = fs.existsSync(runtimeWorker)
    ? runtimeWorker
    : path.resolve("build/sharing-worker.cjs");
  if (!fs.existsSync(worker))
    throw new SharingError(
      "The annotation worker is unavailable. Rebuild Papernook before enabling collaboration.",
      503,
    );
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--max-old-space-size=256",
        "--experimental-permission",
        `--allow-fs-read=${worker}`,
        worker,
      ],
      { env: { NODE_ENV: "production" }, stdio: ["pipe", "pipe", "ignore"] },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: Error, bytes?: Uint8Array) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill("SIGKILL");
      if (error) reject(error);
      else resolve(bytes!);
    };
    const timeout = setTimeout(
      () =>
        finish(
          new SharingError(
            "Annotation processing timed out. No changes were saved.",
            422,
          ),
        ),
      15_000,
    );
    child.on("error", () =>
      finish(new SharingError("The annotation worker could not start.", 503)),
    );
    child.stdin.on("error", () =>
      finish(
        new SharingError(
          "The annotation worker could not process this PDF.",
          422,
        ),
      ),
    );
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > 48 * 1024 * 1024) {
        finish(
          new SharingError(
            "The annotated PDF exceeds the processing limit.",
            413,
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(
          new SharingError(
            "The annotation worker rejected this PDF. No changes were saved.",
            422,
          ),
        );
        return;
      }
      try {
        const result = z
          .discriminatedUnion("ok", [
            z.object({ ok: z.literal(true), pdf: base64Schema }).strict(),
            z
              .object({
                ok: z.literal(false),
                status: z.number().int().min(400).max(599),
                message: z.string().max(300),
              })
              .strict(),
          ])
          .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        if (result.ok) {
          const bytes = Buffer.from(result.pdf, "base64");
          if (bytes.byteLength > MAX_COLLABORATIVE_PDF_BYTES)
            finish(
              new SharingError(
                "The annotated PDF exceeds the 32 MB collaboration limit.",
                413,
              ),
            );
          else finish(undefined, bytes);
        } else finish(new SharingError(result.message, result.status));
      } catch {
        finish(
          new SharingError(
            "The annotation worker returned an invalid result.",
            422,
          ),
        );
      }
    });
    child.stdin.end(
      JSON.stringify({
        current: Buffer.from(current).toString("base64"),
        ...operation,
      }),
    );
  });
}
