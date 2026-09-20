import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  ProcessRunner,
  ProcessExecutionError,
} from "thesidedoor-core/runtime/process";
import {
  buildAgentInvocation,
  buildScpInvocation,
  shellQuote,
  minimalAgentEnvironment,
} from "./invocation";

/**
 * Attachment routing per transport:
 *  - codex CLI, local: images stay where they are; paths are handed via -i.
 *  - codex CLI, SSH: images are scp'd to a temp dir on the agent host first
 *    and the remote paths are referenced instead.
 *  - claude-code CLI (local and SSH): images are embedded as base64 blocks
 *    in a stream-json stdin message; no files reach the agent host.
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

async function run(
  command: string,
  args: string[],
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await new ProcessRunner().execute({
      command,
      args,
      environment: minimalAgentEnvironment([]),
      timeoutMs,
      signal,
    });
  } catch (error) {
    if (error instanceof ProcessExecutionError && error.code === "exit_failed")
      throw new Error(
        `${command}: exited ${error.exitCode}: ${error.diagnostics?.stderr.slice(0, 300) ?? ""}`,
        { cause: error },
      );
    throw error;
  }
}

/**
 * Stage local images for an SSH-remote CLI: mkdir a run-scoped temp dir on
 * the agent host, scp the files, return the remote paths to reference.
 */
export async function stageImagesOverSsh(
  localPaths: string[],
  sshHost: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ paths: string[]; cleanup: () => Promise<void> }> {
  options.signal?.throwIfAborted();
  const remoteDir = `/tmp/papernook-attach-${crypto.randomBytes(6).toString("hex")}`;
  const files = localPaths.map((file, index) => ({
    local: path.resolve(file),
    directory: `${remoteDir}/${index}`,
  }));
  const mkdir = buildAgentInvocation(
    "mkdir",
    ["-m", "700", "-p", remoteDir, ...files.map((file) => file.directory)],
    sshHost,
  );
  const cleanup = async (): Promise<void> => {
    const remove = buildAgentInvocation(
      "rm",
      ["-rf", "--", remoteDir],
      sshHost,
    );
    await run(remove.command, remove.args);
  };
  // buildAgentInvocation quotes for the remote shell; mkdir itself is the CLI.
  try {
    await run(mkdir.command, mkdir.args, options.timeoutMs, options.signal);
    for (const file of files) {
      const scp = buildScpInvocation([file.local], sshHost, file.directory);
      await run(scp.command, scp.args, options.timeoutMs, options.signal);
    }
    return {
      paths: files.map(
        (file) => `${file.directory}/${path.basename(file.local)}`,
      ),
      cleanup,
    };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Image staging failed and remote cleanup did not complete",
        { cause: error },
      );
    }
    throw error;
  }
}

/** A prompt preamble telling a CLI agent where its image attachments live. */
export function imagePromptPreamble(paths: string[]): string {
  if (paths.length === 0) return "";
  const list = paths.map((p) => `- ${p}`).join("\n");
  return `The user attached the following image file(s). Read and look at them before answering:\n${list}\n\n`;
}

export { shellQuote };
