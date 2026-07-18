import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import {
  buildAgentInvocation,
  buildScpInvocation,
  shellQuote,
} from "./invocation";

/**
 * Attachment routing per transport:
 *  - local CLI: images stay where they are; paths are handed to the CLI.
 *  - SSH CLI: images are scp'd to a temp dir on the agent host first and the
 *    remote paths are referenced instead.
 *  - API: callers read the files as base64 (see api.ts).
 */

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function imageMediaType(filePath: string): string {
  return MEDIA_TYPES[path.extname(filePath).toLowerCase()] ?? "image/png";
}

export function readImageBase64(filePath: string): {
  mediaType: string;
  data: string;
} {
  return {
    mediaType: imageMediaType(filePath),
    data: fs.readFileSync(filePath).toString("base64"),
  };
}

function run(
  command: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command}: timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(
          new Error(`${command}: exited ${code}: ${stderr.slice(0, 300)}`),
        );
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Stage local images for an SSH-remote CLI: mkdir a run-scoped temp dir on
 * the agent host, scp the files, return the remote paths to reference.
 */
export async function stageImagesOverSsh(
  localPaths: string[],
  sshHost: string,
): Promise<string[]> {
  const remoteDir = `/tmp/papernook-attach-${crypto.randomBytes(6).toString("hex")}`;
  const mkdir = buildAgentInvocation("mkdir", ["-p", remoteDir], sshHost);
  // buildAgentInvocation quotes for the remote shell; mkdir itself is the CLI.
  await run(mkdir.command, mkdir.args);
  const scp = buildScpInvocation(localPaths, sshHost, remoteDir);
  await run(scp.command, scp.args);
  return localPaths.map((p) => `${remoteDir}/${path.basename(p)}`);
}

/** A prompt preamble telling a CLI agent where its image attachments live. */
export function imagePromptPreamble(paths: string[]): string {
  if (paths.length === 0) return "";
  const list = paths.map((p) => `- ${p}`).join("\n");
  return `The user attached the following image file(s). Read and look at them before answering:\n${list}\n\n`;
}

export { shellQuote };
